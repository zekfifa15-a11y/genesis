(() => {
  "use strict";

  const book = window.BOOKS?.gn;
  const byId = id => document.getElementById(id);
  const feed = byId("leitura");
  const panel = byId("panel");
  if (!book) {
    feed.textContent = "Os dados deste livro estão indisponíveis.";
    return;
  }
  const diagrams = new Set(["GENEALOGIA", "MAPA", "LINHA-TEMPO"]);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const storageKey = "bibliagênesis-v3";
  const store = {
    get() {
      try { return JSON.parse(localStorage.getItem(storageKey)) || {}; }
      catch { return {}; }
    },
    put(value) {
      try { localStorage.setItem(storageKey, JSON.stringify(value)); }
      catch { /* Reading and in-memory preferences continue to work. */ }
    },
  };
  const saved = store.get();
  const state = {
    mode: saved.mode === "reading" ? "reading" : "flow",
    theme: saved.theme === "paper" ? "paper" : "dark",
    font: Number.isFinite(saved.font) ? Math.max(16, Math.min(30, saved.font)) : 19,
    motion: saved.motion !== false,
    focus: Boolean(saved.focus),
    favorites: Array.isArray(saved.favorites) ? saved.favorites : [],
    highlights: Array.isArray(saved.highlights) ? saved.highlights : [],
    completed: Array.isArray(saved.completed) ? saved.completed : [],
    viewedArt: Array.isArray(saved.viewedArt) ? saved.viewedArt : [],
    days: Array.isArray(saved.days) ? saved.days : [],
    notes: saved.notes && typeof saved.notes === "object" ? saved.notes : {},
    mark: saved.mark || null,
    position: saved.position || null,
  };
  const palette = {
    suspense: "#4a5474", tensão: "#9E2B2B", gravidade: "#672938", luto: "#342b61",
    esperança: "#3FA7A3", calma: "#6E8B4E", gratidão: "#a8793a", reverência: "#F2B84B",
  };
  const show = { chapter: 1, index: 0, target: null };
  const words = value => value.trim().split(/\s+/).length;
  const normalize = value => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");
  const textSpace = value => value.replace(/\s+/g, " ").trim();
  const ref = (n, a, b = a) => a === b ? "Gn " + n + ":" + a : "Gn " + n + ":" + a + "–" + b;
  const index = new Map();
  const cardMap = new Map();
  const entries = new Map();
  const artMap = new Map(book.images.map(image => [image.id, image]));
  const allVerses = [];
  let observer = null;
  let scrollFrame = 0;
  let sizeFrame = 0;
  let holdScroll = 0;
  let toastTimer = 0;
  let countdown = 0;
  let countdownCard = null;
  let restoreFocus = null;
  let objectURL = null;

  function el(tag, text, classes = "") {
    const element = document.createElement(tag);
    if (text !== undefined && text !== null) element.textContent = text;
    if (classes) element.className = classes;
    return element;
  }

  function button(label, action, values = {}, classes = "") {
    const element = el("button", label, classes);
    element.type = "button";
    element.dataset.action = action;
    Object.assign(element.dataset, values);
    return element;
  }

  function toast(message) {
    clearTimeout(toastTimer);
    const target = byId("toast");
    target.textContent = message;
    target.hidden = false;
    toastTimer = setTimeout(() => { target.hidden = true; }, 2800);
  }

  function persist() { store.put(state); }

  function localDay(date = new Date()) {
    return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((value, position) =>
      String(value).padStart(position ? 2 : 4, "0")).join("-");
  }

  function streak() {
    const daySet = new Set(state.days);
    const today = new Date();
    if (!daySet.has(localDay(today))) today.setDate(today.getDate() - 1);
    let days = 0;
    while (daySet.has(localDay(today))) {
      days++;
      today.setDate(today.getDate() - 1);
    }
    return days;
  }

  function dayRead() {
    const day = localDay();
    if (!state.days.includes(day)) state.days = [...state.days.slice(-367), day];
  }

  function stageOptions() {
    document.body.dataset.theme = state.theme;
    document.body.classList.toggle("motion", state.motion && !reduced.matches && state.mode === "flow");
    document.body.classList.toggle("focus", state.focus);
    document.body.classList.toggle("reading-mode", state.mode === "reading");
    document.documentElement.style.setProperty("--reading-size", state.font / 16 + "rem");
    byId("change-mode").textContent = state.mode === "flow" ? "Leitura" : "Fluxo";
    feed.className = "feed " + state.mode;
  }

  function sourceMetadata() {
    for (const chapter of book.chapters) {
      const verses = chapter.sections.flatMap(section => section.verses);
      const sections = new Map(chapter.sections.filter(section => section.title).map(section => [section.at, section]));
      const meta = { ...chapter, verses, headings: sections, cards: [], verseCards: new Map() };
      index.set(chapter.n, meta);
      allVerses.push(...verses.map(verse => ({ chapter: chapter.n, verse, normalized: normalize(verse.text) })));
    }
    for (const art of book.images) {
      const [chapter, verse] = art.placement.split(":").map(Number);
      const parts = art.anchor.split(":");
      const end = parts.length > 2 ? Number(parts[2]) : Number((parts[1] || "").split("-").at(-1));
      const target = entries.get(chapter) || [];
      target.push({ art, verse, end });
      entries.set(chapter, target);
    }
  }

  function assemble(meta) {
    const n = meta.n;
    const assigned = entries.get(n) || [];
    const cover = assigned.find(entry => entry.art.type === "CAPA-LIVRO")?.art || null;
    const milestones = new Map(assigned.filter(({ art }) => art.type !== "CAPA-LIVRO" && !art.placement_after)
      .map(entry => [entry.verse, entry]));
    const inserts = new Map(assigned.filter(entry => entry.art.placement_after).map(entry => [entry.verse, entry.art]));
    const cards = [{ type: "open", chapter: n, id: "abertura-" + n, art: cover }];
    let buffer = [];
    let total = 0;
    let owner = null;
    let sinceImage = 2;
    let primary = false;

    function flush() {
      if (!buffer.length) return;
      const first = buffer[0].n;
      const last = buffer.at(-1).n;
      const available = owner && first <= owner.end && !owner.art.missing;
      const art = owner && (primary || (available && sinceImage >= 2)) ? owner.art : null;
      const card = { type: "passage", chapter: n, id: "gn-" + n + "-" + first,
        first, last, verses: buffer, art, primary, label: ref(n, first, last) };
      cards.push(card);
      for (const verse of buffer) meta.verseCards.set(verse.n, card.id);
      sinceImage = available && art ? 0 : sinceImage + 1;
      primary = false;
      buffer = [];
      total = 0;
    }

    for (const verse of meta.verses) {
      const startArt = milestones.get(verse.n);
      const section = meta.headings.get(verse.n);
      const size = words(verse.text);
      if (startArt || section && section.after === undefined || total + size > 60) flush();
      if (startArt) {
        owner = startArt;
        primary = true;
      }
      buffer.push(verse);
      total += size;
      if (inserts.has(verse.n)) {
        flush();
        const art = inserts.get(verse.n);
        cards.push({ type: "diagram", chapter: n, id: art.id, art, primary: true, first: verse.n, label: art.ref });
      }
    }
    flush();
    if (book.hooks[n]) cards.push({ type: "hook", chapter: n, id: "gancho-" + n });
    cards.push({ type: "quiz", chapter: n, id: "quiz-" + n }, { type: "finish", chapter: n, id: "fim-" + n });
    for (const [position, card] of cards.entries()) cardMap.set(card.id, { card, position });
    meta.cards = cards;
  }

  function pathFor(art, thumb = false) { return "images/gn/" + (thumb ? "thumb/" : "") + art.id + ".webp"; }
  function current() { return index.get(show.chapter).cards[show.index]; }
  function anchor(card = current()) { return card.chapter + ":" + (show.target || card.first || 1); }

  function picture(art, lazy = true, thumb = false, decorative = false) {
    const image = el("img");
    image.alt = decorative ? "" : art.alt || "";
    image.decoding = "async";
    image.loading = lazy ? "lazy" : "eager";
    if (lazy && !thumb) image.dataset.src = pathFor(art);
    else image.src = pathFor(art, thumb);
    return image;
  }

  function rectifiedArtwork(root, art) {
    const holder = el("div", null, "media-wrap");
    const image = picture(art);
    image.className = "hero-art";
    image.addEventListener("load", () => {
      if (root.classList.contains("active") && rememberArtwork(art)) persist();
    });
    image.addEventListener("error", () => {
      holder.remove();
      root.querySelector(".shade")?.remove();
      root.classList.replace("has-art", "typographic");
    }, { once: true });
    holder.append(image);
    root.append(holder, el("div", null, "shade"));
  }

  function rememberArtwork(art) {
    if (state.viewedArt.includes(art.id)) return false;
    state.viewedArt.push(art.id);
    return true;
  }

  function renderDiagram(art) {
    const result = el("div", null, "diagram");
    const grid = el("div", null, "diagram-labels");
    grid.style.setProperty("--columns", art.labels.length > 6 ? 3 : Math.min(2, art.labels.length));
    for (const label of art.labels) grid.append(el("span", label));
    result.dataset.diagram = art.id;
    result.append(grid, el("p", art.ref, "diagram-ref"));
    return result;
  }

  function renderVerses(card) {
    const fragment = el("div", null, "verse-block");
    const chapter = index.get(card.chapter);
    for (const verse of card.verses || []) {
      const heading = chapter.headings.get(verse.n);
      if (heading && heading.after === undefined) fragment.append(el("h3", heading.title, "section-title"));
      const element = el("p", null, "verse" + (verse.poetry ? " poetry" : ""));
      const key = card.chapter + ":" + verse.n;
      element.dataset.verse = key;
      if (state.highlights.includes(key)) element.dataset.highlight = "true";
      if (verse.n === show.target) element.dataset.target = "true";
      const number = el("span", verse.n, "num");
      number.setAttribute("aria-label", "Versículo " + verse.n);
      element.append(number);
      const body = el("span", null, "scripture");
      const characters = Array.from(verse.text);
      const insertions = [];
      for (const noteId of verse.notes) {
        const note = chapter.footnotes[noteId];
        const control = button(note.label, "footnote", { chapter: card.chapter, note: noteId }, "note-call");
        control.setAttribute("aria-label", "Nota " + note.label + " de " + ref(card.chapter, verse.n));
        insertions.push([note.afterCharacter, control]);
      }
      if (heading && heading.after !== undefined) {
        const inline = el("span", heading.title, "section-title inline-heading");
        inline.setAttribute("role", "heading");
        inline.setAttribute("aria-level", "3");
        insertions.push([heading.after, inline]);
      }
      insertions.sort((left, right) => left[0] - right[0]);
      let offset = 0;
      for (const [position, element] of insertions) {
        body.append(document.createTextNode(characters.slice(offset, position).join("")), element);
        offset = position;
      }
      body.append(document.createTextNode(characters.slice(offset).join("")));
      element.append(body);
      fragment.append(element);
    }
    return fragment;
  }

  function interlude(root, card, text) {
    const chapter = index.get(card.chapter);
    const label = el("p", "", "interface-label");
    const title = el("h2");
    const actions = el("div", null, "actions");
    text.append(label, title);
    root.classList.add("interlude");
    switch (card.type) {
      case "open": {
        root.classList.add("opening");
        label.textContent = card.chapter === 1 ? "Bíblia Ilustrada · NVI" : "Abertura · NVI";
        title.textContent = card.chapter === 1 ? book.name : chapter.heading;
        const arc = book.arcs.find(item => card.chapter >= item.from && card.chapter <= item.to);
        text.append(el("p", arc.title));
        actions.append(button("Ler capítulo", "next", {}, "primary"), button("Índice", "index", {}, "pill"));
        break;
      }
      case "hook":
        label.textContent = "No próximo capítulo";
        title.textContent = book.hooks[card.chapter];
        actions.append(button("Continuar", "next", {}, "primary"));
        break;
      case "quiz":
        label.textContent = "Quiz opcional";
        title.textContent = "Relembre o capítulo";
        text.append(el("p", "Três perguntas com referência ao texto de Gênesis."));
        actions.append(button("Fazer quiz", "quiz", {}, "primary"), button("Pular", "next", {}, "pill"));
        break;
      case "finish": {
        label.textContent = "Leitura concluída";
        title.textContent = card.chapter === 50 ? "Gênesis concluído" : "Capítulo " + card.chapter + " concluído";
        const mosaic = el("div", null, "summary-pictures");
        mosaic.hidden = true;
        text.append(mosaic);
        const keyVerse = chapter.verses.find(v => words(v.text) >= 8 && words(v.text) <= 38) || chapter.verses[0];
        const quote = el("blockquote", keyVerse.text);
        quote.append(el("cite", ref(card.chapter, keyVerse.n)));
        text.append(quote);
        if (card.chapter < 50) {
          const cancelledBefore = cancelled.has(card.id);
          const timer = el("p", cancelledBefore ? "Avanço automático cancelado." : "Próximo capítulo em 5 s", "end-timer");
          const cancel = button("Cancelar contagem", "cancel-countdown", {}, "pill");
          cancel.disabled = cancelledBefore;
          timer.setAttribute("aria-live", "polite");
          text.append(timer);
          actions.append(button("Próximo capítulo", "next-chapter", {}, "primary"), cancel);
        } else {
          actions.append(button("Rever capítulos", "index", {}, "primary"));
        }
        break;
      }
    }
    text.append(actions);
  }

  function renderCard(card) {
    const actualArt = card.art && !card.art.missing;
    const root = el("article", null, "card " + (actualArt ? "has-art" : "typographic"));
    root.dataset.id = card.id;
    root.dataset.kind = card.type;
    if (card.art) root.dataset.art = card.art.id;
    root.setAttribute("aria-label", card.label || index.get(card.chapter).heading);
    if (card.art) root.style.setProperty("--mood", palette[normalize(card.art.emotion)] || palette[card.art.emotion.toLowerCase()] || "#ad7d3a");
    if (actualArt) rectifiedArtwork(root, card.art);
    const diagram = card.primary && card.art && diagrams.has(card.art.type);
    if (diagram) root.append(renderDiagram(card.art));
    const copy = el("div", null, "copy");
    if (card.type === "passage") {
      copy.append(el("p", card.label, "reference"), renderVerses(card));
      const more = button("Ler trecho inteiro", "expand", { id: card.id }, "pill expand");
      more.hidden = true;
      copy.append(more);
    } else if (card.type !== "diagram") {
      interlude(root, card, copy);
    }
    root.append(copy);
    return root;
  }

  function watchArtwork() {
    observer?.disconnect();
    const lazy = feed.querySelectorAll("img[data-src]");
    const load = image => {
      if (!image.dataset.src) return;
      image.src = image.dataset.src;
      delete image.dataset.src;
    };
    if (!("IntersectionObserver" in window)) { lazy.forEach(load); return; }
    observer = new IntersectionObserver(items => {
      for (const { target, isIntersecting } of items) {
        if (!isIntersecting) continue;
        load(target);
        observer.unobserve(target);
      }
    }, { root: feed, rootMargin: "60% 0px" });
    lazy.forEach(image => observer.observe(image));
  }

  function queueArt(position) {
    for (let step = 0; step <= 2; step++) {
      const image = feed.children[position + step]?.querySelector("img[data-src]");
      if (!image) continue;
      image.loading = "eager";
      image.src = image.dataset.src;
      delete image.dataset.src;
      observer?.unobserve(image);
    }
  }

  function expansion() {
    cancelAnimationFrame(sizeFrame);
    sizeFrame = requestAnimationFrame(() => {
      if (state.mode === "reading") return;
      for (const item of feed.children) {
        const block = item.querySelector(".verse-block");
        if (!block) continue;
        const expand = item.querySelector(".expand");
        const clipped = block.scrollHeight > block.clientHeight + 2;
        expand.hidden = !clipped;
        block.classList.toggle("is-excerpt", clipped);
      }
    });
  }

  function updateRail() {
    const nav = byId("arc-rail");
    const visible = [];
    for (const arc of book.arcs) {
      const item = button("", "go-chapter", { chapter: arc.from });
      item.append(el("span", "Gn " + arc.from + "–" + arc.to), el("span", arc.title));
      if (show.chapter >= arc.from && show.chapter <= arc.to) item.setAttribute("aria-current", "true");
      visible.push(item);
    }
    nav.replaceChildren(...visible);
    byId("rail-stats").textContent = state.completed.length + "/50 capítulos · " + streak() + " dias seguidos";
  }

  function updateButtons(card) {
    const pressed = state.favorites.includes(card.id);
    const favorite = document.querySelector(".card-tools [data-action=favorite]");
    favorite.setAttribute("aria-pressed", String(pressed));
    favorite.firstElementChild.textContent = pressed ? "♥" : "♡";
    const bookmark = document.querySelector(".card-tools [data-action=mark]");
    bookmark.setAttribute("aria-pressed", String(state.mark === card.id));
    document.querySelector(".card-tools").hidden = card.type !== "passage" && card.type !== "diagram";
  }

  function updateSelection(persistPosition = true) {
    const card = current();
    const meta = index.get(show.chapter);
    for (const item of feed.children) item.classList.toggle("active", item.dataset.id === card.id);
    const start = card.type === "open" ? 1 : card.first || meta.verses.length + 1;
    const left = meta.verses.filter(verse => verse.n >= start).reduce((sum, verse) => sum + words(verse.text), 0);
    byId("top-location").textContent = "Cap. " + show.chapter + " de 50 · ~" + Math.ceil(left / 200) + " min restantes";
    byId("chapter-progress").value = Math.max(0, Math.min(100, (start - 1) * 100 / meta.verses.length));
    byId("scene-position").textContent = card.label || index.get(show.chapter).heading;
    byId("next").disabled = show.chapter === 50 && show.index === meta.cards.length - 1;
    byId("previous").disabled = show.chapter === 1 && show.index === 0;
    updateButtons(card);
    queueArt(show.index);
    const artwork = feed.children[show.index]?.querySelector(".hero-art");
    if (artwork?.complete && artwork.naturalWidth) rememberArtwork(card.art);
    if (card.type === "passage") dayRead();
    if (persistPosition) {
      state.position = card.id;
      persist();
    }
    if (card.type === "finish") finishChapter(card);
    else stopCountdown();
  }

  function goPosition(position, animate = false, write = true) {
    const item = feed.children[position];
    if (!item) return;
    show.index = position;
    const y = item.getBoundingClientRect().top - feed.getBoundingClientRect().top + feed.scrollTop;
    holdScroll = performance.now() + (animate ? 540 : 100);
    feed.scrollTo({ top: Math.max(0, y - (state.mode === "reading" ? 65 : 0)),
      behavior: animate && !reduced.matches ? "smooth" : "instant" });
    updateSelection(write);
    expansion();
  }

  function renderChapter(position) {
    const chapter = index.get(show.chapter);
    stageOptions();
    feed.replaceChildren(...chapter.cards.map(renderCard));
    watchArtwork();
    updateRail();
    goPosition(position);
  }

  function browse(chapter, verse = null, id = null) {
    const meta = index.get(chapter);
    if (!meta) return;
    show.target = verse && meta.verseCards.has(verse) ? verse : null;
    show.chapter = chapter;
    const record = cardMap.get(id || meta.verseCards.get(verse));
    renderChapter(record?.card.chapter === chapter ? record.position : 0);
    if (show.target) {
      const selectedVerse = feed.querySelector('.active [data-target="true"]');
      if (state.mode === "reading" && selectedVerse) selectedVerse.scrollIntoView({ block: "center" });
    }
  }

  function navigate(delta) {
    const meta = index.get(show.chapter);
    const position = show.index + delta;
    show.target = null;
    if (position >= 0 && position < meta.cards.length) goPosition(position, state.mode === "flow");
    else if (index.has(show.chapter + delta)) {
      const target = index.get(show.chapter + delta);
      browse(target.n, null, delta < 0 ? target.cards.at(-1).id : null);
    }
  }

  const cancelled = new Set();

  function stopCountdown() {
    clearInterval(countdown);
    countdown = 0;
    countdownCard = null;
  }

  function finishChapter(card) {
    const artwork = new Set(index.get(card.chapter).cards.filter(item => item.art && !item.art.missing)
      .map(item => item.art.id));
    const seen = state.viewedArt.filter(id => artwork.has(id)).slice(-3);
    const mosaic = feed.querySelector(".active .summary-pictures");
    mosaic.replaceChildren(...seen.map(id => picture(artMap.get(id), false, true)));
    mosaic.hidden = !seen.length;
    if (!state.completed.includes(card.chapter)) {
      state.completed = [...state.completed, card.chapter].sort((a, b) => a - b);
      dayRead();
      persist();
      updateRail();
    }
    if (card.chapter === 50 || countdownCard === card.id || cancelled.has(card.id)) return;
    stopCountdown();
    countdownCard = card.id;
    let left = 5;
    const timer = feed.querySelector(".active .end-timer");
    if (!timer) return;
    timer.textContent = "Próximo capítulo em 5 s";
    countdown = setInterval(() => {
      if (current().id !== card.id || panel.open) return;
      left--;
      if (left === 0) {
        stopCountdown();
        browse(card.chapter + 1);
      } else {
        timer.textContent = "Próximo capítulo em " + left + " s";
      }
    }, 1000);
  }

  function dialog(title, content) {
    if (!panel.open) restoreFocus = document.activeElement;
    byId("panel-title").textContent = title;
    byId("panel-body").replaceChildren(content);
    panel.scrollTop = 0;
    if (!panel.open) panel.showModal();
    (panel.querySelector("[autofocus]") || panel.querySelector(".panel-head button")).focus({ preventScroll: true });
  }

  function tile(label, action, data, thumb, face = false) {
    const entry = button("", action, data, "tile");
    const picture = thumb ? el("img", "", "thumbnail" + (face ? " avatar" : "")) : el("span", "", "thumbnail");
    if (thumb) {
      picture.src = thumb;
      picture.alt = "";
      picture.loading = "lazy";
      picture.decoding = "async";
    } else {
      picture.setAttribute("aria-hidden", "true");
    }
    entry.append(picture, el("span", label));
    return entry;
  }

  function thumbnailFor(chapter, first = 1) {
    const list = entries.get(chapter) || [];
    const matching = list.find(({ art, verse, end }) => !art.missing && verse <= first && end >= first);
    const fallback = list.find(({ art }) => !art.missing);
    return matching || fallback ? pathFor((matching || fallback).art, true) : null;
  }

  function showIndex(tab = "chapters") {
    const box = document.createDocumentFragment();
    const nav = el("div", null, "tabs");
    const options = [["chapters", "Capítulos"], ["favorites", "Favoritos"], ["characters", "Personagens"], ["stats", "Leitura"]];
    for (const [id, title] of options) {
      const item = button(title, "index", { tab: id }, "pill");
      item.setAttribute("aria-pressed", String(id === tab));
      nav.append(item);
    }
    box.append(nav);
    if (tab === "chapters") {
      for (const arc of book.arcs) {
        const group = el("section", null, "index-group");
        const grid = el("div", null, "chapter-grid");
        group.append(el("h3", arc.title));
        for (let number = arc.from; number <= arc.to; number++) {
          const label = "Cap. " + number + (state.completed.includes(number) ? " ✓" : "");
          grid.append(tile(label, "section-index", { chapter: number }, thumbnailFor(number)));
        }
        group.append(grid);
        box.append(group);
      }
    } else if (tab === "favorites") {
      const gallery = el("div", null, "gallery");
      if (!state.favorites.length) box.append(el("p", "Os cards que você favoritar aparecem aqui.", "help"));
      for (const id of state.favorites) {
        const card = cardMap.get(id)?.card;
        if (!card) continue;
        gallery.append(tile(card.label || book.name + " " + card.chapter, "go-card", { id },
          card.art && !card.art.missing ? pathFor(card.art, true) : null));
      }
      box.append(gallery);
    } else if (tab === "characters") {
      const gallery = el("div", null, "gallery");
      for (const person of book.characters) {
        const [chapter, verse] = person.ref.split(":").map(value => parseInt(value, 10));
        gallery.append(tile(person.name + " · " + ref(chapter, verse), "go-verse", { chapter, verse },
          person.available ? "images/personagens/" + person.id + ".webp" : null, true));
      }
      box.append(gallery);
    } else {
      const count = streak();
      box.append(el("p", count + (count === 1 ? " dia seguido" : " dias seguidos") +
        " · " + state.completed.length + " de 50 capítulos concluídos", "help"));
      if (state.mark && cardMap.has(state.mark)) box.append(button("Ir à posição marcada", "go-card", { id: state.mark }, "pill"));
      const achieved = book.arcs.filter(arc => Array.from({ length: arc.to - arc.from + 1 }, (_, i) => i + arc.from)
        .every(chapter => state.completed.includes(chapter)));
      if (achieved.length) {
        box.append(el("h3", "Arcos concluídos"));
        for (const arc of achieved) box.append(el("p", arc.title));
      }
    }
    dialog("Índice de Gênesis", box);
  }

  function showSections(chapter) {
    const meta = index.get(chapter);
    if (!meta) return;
    const content = document.createDocumentFragment();
    const actions = el("div", null, "panel-actions");
    actions.append(button("Começar capítulo", "go-chapter", { chapter }, "primary"), button("Voltar", "index", {}, "pill"));
    const gallery = el("div", null, "gallery");
    for (const section of meta.headings.values()) gallery.append(tile(section.title, "go-verse",
      { chapter, verse: section.at }, thumbnailFor(chapter, section.at)));
    content.append(actions, gallery);
    dialog("Gênesis " + chapter, content);
  }

  function highlightSnippet(label, term) {
    const span = el("span");
    const folded = normalize(label);
    const position = folded.indexOf(term);
    if (position >= 0 && term) {
      span.append(document.createTextNode(label.slice(0, position)),
        el("mark", label.slice(position, position + term.length)),
        document.createTextNode(label.slice(position + term.length)));
    } else {
      span.textContent = label;
    }
    return span;
  }

  function search() {
    const content = document.createDocumentFragment();
    const input = el("input");
    input.type = "search";
    input.placeholder = "Ex.: luz ou Gn 12:1";
    input.setAttribute("aria-label", "Palavra ou referência");
    input.setAttribute("autofocus", "");
    const status = el("p", "Busque no texto integral de Gênesis.", "help");
    status.setAttribute("aria-live", "polite");
    const found = el("div", null, "result-grid");
    input.addEventListener("input", () => {
      found.replaceChildren();
      const term = normalize(input.value.trim());
      if (!term) {
        status.textContent = "Busque no texto integral de Gênesis.";
        return;
      }
      const reference = /^(?:(?:genesis|gn)\s*)?(\d{1,2})(?:\s*[:.]\s*(\d{1,2}))?$/.exec(term);
      const matching = reference ? allVerses.filter(item => item.chapter === Number(reference[1]) &&
        item.verse.n === Number(reference[2] || "1")) : allVerses.filter(item => item.normalized.includes(term));
      status.textContent = matching.length === 0 ? "Nenhum resultado."
        : matching.length > 60 ? "Primeiros 60 de " + matching.length + " resultados." : matching.length + " resultado(s).";
      for (const { chapter, verse, normalized } of matching.slice(0, 60)) {
        const item = button("", "go-verse", { chapter, verse: verse.n });
        const offset = reference ? 0 : Math.max(0, normalized.indexOf(term) - 58);
        const preview = textSpace(verse.text).slice(offset, offset + 175);
        item.append(el("strong", ref(chapter, verse.n)), highlightSnippet(preview, reference ? "" : term));
        found.append(item);
      }
    });
    content.append(input, status, found);
    dialog("Buscar em Gênesis", content);
  }

  function settings() {
    const box = el("div", null, "preference-list");
    const opts = [
      ["Tema", state.theme === "paper" ? "Pergaminho" : "Escuro", "theme"],
      ["Movimento das imagens", reduced.matches ? "Reduzido pelo dispositivo" : state.motion ? "Ativado" : "Desativado", "motion"],
      ["Modo foco", state.focus ? "Ativado" : "Desativado", "focus"],
    ];
    for (const [title, value, action] of opts) {
      const row = el("div", null, "prefs");
      const control = button(value, action, {}, "pill");
      if (action === "motion" && reduced.matches) control.disabled = true;
      row.append(el("span", title), control);
      box.append(row);
    }
    const fontRow = el("div", null, "prefs");
    const stepper = el("div", null, "stepper");
    stepper.append(button("A−", "font", { delta: "-1" }, "pill"), el("output", state.font + " px"),
      button("A+", "font", { delta: "1" }, "pill"));
    fontRow.append(el("span", "Tamanho da fonte"), stepper);
    box.append(fontRow);
    dialog("Preferências de leitura", box);
  }

  function setToggle(property, value) {
    state[property] = value;
    stageOptions();
    expansion();
    persist();
    settings();
  }

  function favor(card = current()) {
    if (card.type !== "passage" && card.type !== "diagram") return;
    const add = !state.favorites.includes(card.id);
    state.favorites = add ? [...state.favorites, card.id] : state.favorites.filter(id => id !== card.id);
    persist();
    updateButtons(card);
    const control = document.querySelector(".card-tools [data-action=favorite]");
    control.classList.remove("favorited-pulse");
    requestAnimationFrame(() => control.classList.add("favorited-pulse"));
    toast(add ? "Card favoritado" : "Card removido dos favoritos");
  }

  function toggleHighlight(key = anchor()) {
    const add = !state.highlights.includes(key);
    state.highlights = add ? [...state.highlights, key] : state.highlights.filter(id => id !== key);
    for (const target of document.querySelectorAll("[data-verse]")) {
      if (target.dataset.verse === key) target.dataset.highlight = String(add);
    }
    persist();
    toast(add ? "Versículo destacado" : "Destaque removido");
  }

  function annotation(key) {
    const content = document.createDocumentFragment();
    const caption = el("p", "Anotação pessoal · " + key, "help");
    const input = el("textarea");
    input.setAttribute("aria-label", "Sua anotação");
    input.setAttribute("autofocus", "");
    input.value = state.notes[key] || "";
    const actions = el("div", null, "panel-actions");
    const save = button("Salvar anotação", "save-annotation", { key }, "primary");
    const highlight = button(state.highlights.includes(key) ? "Remover destaque" : "Destacar versículo",
      "highlight", { key }, "pill");
    actions.append(save, highlight);
    content.append(caption, input, actions);
    dialog("Anotação", content);
  }

  function bibleNote(chapterNumber, id) {
    const note = index.get(chapterNumber)?.footnotes[id];
    if (!note) return;
    const box = document.createDocumentFragment();
    box.append(el("p", "Nota " + note.label + " · " + note.printedRef, "help"), el("p", note.text, "verse-block"));
    dialog("Nota da edição", box);
  }

  function quizCard(chapterNumber, place = 0, score = 0) {
    const chapterQuiz = book.quiz[chapterNumber];
    const box = document.createDocumentFragment();
    if (place >= chapterQuiz.length) {
      box.append(el("p", "Você acertou " + score + " de " + chapterQuiz.length + " perguntas."),
        button("Voltar à leitura", "close", {}, "primary"));
      dialog("Quiz · Gênesis " + chapterNumber, box);
      return;
    }
    const q = chapterQuiz[place];
    const title = el("p", q.q, "question");
    const options = el("div", null, "quiz-options");
    const response = el("p", "", "quiz-feedback");
    response.setAttribute("aria-live", "polite");
    const next = button("Próxima pergunta", "quiz-next", { chapter: chapterNumber, place: place + 1, score }, "primary");
    next.hidden = true;
    q.options.forEach((option, i) => {
      const answer = el("button", option);
      answer.type = "button";
      answer.addEventListener("click", () => {
        options.querySelectorAll("button").forEach((item, index) => {
          item.disabled = true;
          if (index === i || index === q.answer) item.dataset.correct = String(index === q.answer);
        });
        const correct = i === q.answer;
        next.dataset.score = score + Number(correct);
        response.textContent = (correct ? "Resposta correta. " : "A resposta é “" + q.options[q.answer] + "”. ") + "Gn " + q.ref;
        next.hidden = false;
      });
      options.append(answer);
    });
    box.append(el("p", (place + 1) + " de " + chapterQuiz.length, "help"), title, options, response, next);
    dialog("Quiz · Gênesis " + chapterNumber, box);
  }

  function wrapCanvas(context, value, width) {
    return value.split("\n").flatMap(paragraph => {
      if (!paragraph.trim()) return [""];
      const results = [];
      let line = "";
      for (const word of paragraph.trim().split(/\s+/)) {
        const next = line ? line + " " + word : word;
        if (line && context.measureText(next).width > width) {
          results.push(line);
          line = word;
        } else line = next;
      }
      return [...results, line];
    });
  }

  function shareCanvas(card, verse, image) {
    const canvas = document.createElement("canvas");
    canvas.width = 1080;
    canvas.height = 1920;
    const context = canvas.getContext("2d");
    const bg = context.createRadialGradient(540, 480, 100, 540, 640, 1300);
    bg.addColorStop(0, "#334261");
    bg.addColorStop(1, "#0E1320");
    context.fillStyle = bg;
    context.fillRect(0, 0, 1080, 1920);
    if (image?.naturalWidth && image.naturalHeight) {
      const factor = Math.max(1080 / image.naturalWidth, 1920 / image.naturalHeight);
      const width = image.naturalWidth * factor;
      const height = image.naturalHeight * factor;
      context.drawImage(image, (1080 - width) / 2, (1920 - height) / 2, width, height);
    }
    const gradient = context.createLinearGradient(0, 570, 0, 1920);
    gradient.addColorStop(0, "#090d1700");
    gradient.addColorStop(.4, "#090d17df");
    gradient.addColorStop(1, "#090d17");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 1080, 1920);
    let size = 56;
    let lines;
    let leading;
    do {
      context.font = size + "px Literata, Georgia, serif";
      leading = Math.round(size * 1.42);
      lines = wrapCanvas(context, verse.text, 924);
      if (lines.length * leading < 685 || size === 24) break;
      size -= 2;
    } while (true);
    context.fillStyle = "#F3E9D2";
    context.textAlign = "left";
    const top = 1680 - Math.max(leading, lines.length * leading);
    for (let i = 0; i < lines.length; i++) context.fillText(lines[i], 78, top + leading * i);
    context.fillStyle = "#F2B84B";
    context.font = "bold 31px Inter, sans-serif";
    context.fillText("GÊNESIS " + card.chapter + ":" + verse.n + " · NVI", 78, 1740);
    context.fillStyle = "#c8c2b7";
    context.font = "23px Inter, sans-serif";
    context.fillText("Bíblia Ilustrada", 78, 1826);
    return canvas;
  }

  async function share() {
    const card = current();
    const meta = index.get(card.chapter);
    const verse = meta.verses.find(v => v.n === (show.target || card.first)) || meta.verses[0];
    const frame = feed.querySelector(".active .hero-art");
    let blob;
    try {
      await document.fonts?.ready;
      if (frame) await frame.decode().catch(() => {});
      blob = await new Promise(resolve => shareCanvas(card, verse, frame).toBlob(resolve, "image/png"));
    } catch {
      blob = await new Promise(resolve => shareCanvas(card, verse, null).toBlob(resolve, "image/png"));
    }
    if (!blob) { toast("Não foi possível montar o compartilhamento."); return; }
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = URL.createObjectURL(blob);
    const content = document.createDocumentFragment();
    const preview = el("img", null, "share-preview");
    preview.src = objectURL;
    preview.alt = ref(card.chapter, verse.n);
    const download = el("a", "Salvar imagem", "pill");
    download.href = objectURL;
    download.download = "genesis-" + card.chapter + "-" + verse.n + ".png";
    const actions = el("div", null, "panel-actions");
    actions.append(download);
    const shareable = new File([blob], download.download, { type: "image/png" });
    if (navigator.canShare?.({ files: [shareable] })) {
      const native = el("button", "Compartilhar", "primary");
      native.type = "button";
      native.addEventListener("click", () => navigator.share({ files: [shareable], title: "Gênesis" }).catch(() => {}));
      actions.append(native);
    }
    content.append(preview, actions);
    dialog("Compartilhar versículo", content);
  }

  function closePanel() {
    if (panel.open) panel.close();
  }

  document.addEventListener("click", event => {
    const source = event.target.closest("button[data-action]");
    if (!source || source.disabled) return;
    const { action, chapter, verse, id, key, delta, tab, place, score, note } = source.dataset;
    switch (action) {
      case "next": navigate(1); break;
      case "previous": navigate(-1); break;
      case "index": showIndex(tab); break;
      case "section-index": showSections(Number(chapter)); break;
      case "go-chapter": closePanel(); browse(Number(chapter)); break;
      case "go-verse": closePanel(); browse(Number(chapter), Number(verse)); break;
      case "go-card": {
        const record = cardMap.get(id);
        if (record) { closePanel(); browse(record.card.chapter, null, id); }
        break;
      }
      case "search": search(); break;
      case "settings": settings(); break;
      case "close": closePanel(); break;
      case "footnote": bibleNote(Number(chapter), note); break;
      case "expand": {
        const card = cardMap.get(id)?.card;
        if (card) dialog(card.label, renderVerses(card));
        break;
      }
      case "mode":
        state.mode = state.mode === "flow" ? "reading" : "flow";
        renderChapter(show.index);
        persist();
        break;
      case "font":
        state.font = Math.max(16, Math.min(30, state.font + Number(delta)));
        setToggle("font", state.font);
        break;
      case "theme": setToggle("theme", state.theme === "dark" ? "paper" : "dark"); break;
      case "motion": setToggle("motion", !state.motion); break;
      case "focus": setToggle("focus", !state.focus); break;
      case "favorite": favor(); break;
      case "mark":
        state.mark = state.mark === current().id ? null : current().id;
        updateButtons(current());
        persist();
        toast(state.mark ? "Posição marcada" : "Marca removida");
        break;
      case "annotation": annotation(anchor()); break;
      case "save-annotation": {
        const value = panel.querySelector("textarea")?.value.trim();
        if (value) state.notes[key] = value;
        else delete state.notes[key];
        persist();
        closePanel();
        toast(value ? "Anotação salva" : "Anotação removida");
        break;
      }
      case "highlight": toggleHighlight(key); annotation(key); break;
      case "share": void share(); break;
      case "quiz": quizCard(show.chapter); break;
      case "quiz-next": quizCard(Number(chapter), Number(place), Number(score)); break;
      case "next-chapter": if (show.chapter < 50) browse(show.chapter + 1); break;
      case "cancel-countdown":
        cancelled.add(current().id);
        stopCountdown();
        feed.querySelector(".active .end-timer").textContent = "Avanço automático cancelado.";
        source.disabled = true;
        break;
    }
  });
  panel.addEventListener("close", () => {
    if (objectURL) {
      URL.revokeObjectURL(objectURL);
      objectURL = null;
    }
    if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
  });
  panel.addEventListener("click", event => {
    if (event.target !== panel) return;
    const bounds = panel.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closePanel();
  });

  feed.addEventListener("scroll", () => {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      if (performance.now() < holdScroll) return;
      const threshold = feed.getBoundingClientRect().top + feed.clientHeight * .38;
      let next = show.index;
      for (const [position, element] of Array.from(feed.children).entries()) {
        if (element.getBoundingClientRect().top <= threshold) next = position;
        else break;
      }
      if (next !== show.index) {
        show.index = next;
        show.target = null;
        updateSelection();
        expansion();
      }
      if (state.mode === "flow" && state.motion && !reduced.matches) {
        const currentArt = feed.children[show.index]?.querySelector(".media-wrap");
        if (currentArt) {
          const top = feed.children[show.index].getBoundingClientRect().top;
          currentArt.style.setProperty("--parallax", Math.round(top * -.035) + "px");
        }
      }
    });
  }, { passive: true });

  let pointer = null;
  let recentTap = null;
  let long = 0;
  function clearPointer() { clearTimeout(long); pointer = null; }
  feed.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.target.closest("button,a")) return;
    const verse = event.target.closest("[data-verse]");
    pointer = { x: event.clientX, y: event.clientY, id: current().id, time: performance.now(), long: false };
    if (verse) long = setTimeout(() => {
      if (!pointer) return;
      toggleHighlight(verse.dataset.verse);
      pointer.long = true;
    }, 540);
  }, { passive: true });
  feed.addEventListener("pointermove", event => {
    if (pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 9) clearPointer();
  }, { passive: true });
  feed.addEventListener("pointercancel", clearPointer, { passive: true });
  feed.addEventListener("pointerup", () => {
    if (pointer && !pointer.long && performance.now() - pointer.time < 420) {
      const now = performance.now();
      if (recentTap?.id === pointer.id && now - recentTap.time < 300) {
        favor();
        recentTap = null;
      } else recentTap = { id: pointer.id, time: now };
    }
    clearPointer();
  }, { passive: true });
  window.addEventListener("keydown", event => {
    if (panel.open || state.mode !== "flow" || event.altKey || event.ctrlKey || event.metaKey) return;
    if (["ArrowDown","PageDown","ArrowUp","PageUp"].includes(event.key)) {
      event.preventDefault();
      navigate(event.key === "ArrowDown" || event.key === "PageDown" ? 1 : -1);
    }
  });
  window.addEventListener("resize", expansion);
  reduced.addEventListener("change", stageOptions);
  sourceMetadata();
  for (const chapter of index.values()) assemble(chapter);
  const requested = /^#(?:gn-)?(\d{1,2})(?:[:.-](\d{1,2}))?$/.exec(location.hash);
  const restored = cardMap.get(state.position)?.card;
  if (requested && index.has(Number(requested[1]))) browse(Number(requested[1]), Number(requested[2]) || null);
  else if (restored) browse(restored.chapter, null, restored.id);
  else browse(1);
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }
})();
