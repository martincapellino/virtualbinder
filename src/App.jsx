import { useState, useContext, createContext, useCallback, useRef, useEffect, useMemo } from "react";

// ─── CONTEXT ────────────────────────────────────────────────────────────────
const BinderContext = createContext(null);
const useBinder = () => {
  const ctx = useContext(BinderContext);
  if (!ctx) throw new Error("useBinder must be used within BinderProvider");
  return ctx;
};

function BinderProvider({ children }) {
  const [binders, setBinders] = useState(() => {
    try {
      const stored = localStorage.getItem("vb_binders");
      if (!stored) return [];
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  });

  const [currentPage, setCurrentPage] = useState(0);

  const save = useCallback((next) => {
    setBinders(next);
    try {
      localStorage.setItem("vb_binders", JSON.stringify(next));
    } catch (e) {
      console.error("Error guardando binders:", e);
    }
  }, []);

  // Restaurar el último binder activo entre recargas
  const [activeBinder, setActiveBinderRaw] = useState(() => {
    try {
      const stored = localStorage.getItem("vb_binders");
      const parsed = stored ? JSON.parse(stored) : [];
      const lastId = localStorage.getItem("vb_active_id");
      if (lastId && Array.isArray(parsed)) {
        return parsed.find(b => b.id === lastId) || null;
      }
      return null;
    } catch { return null; }
  });


  const setActiveBinder = useCallback((b) => {
    setActiveBinderRaw(b);
    try {
      localStorage.setItem("vb_active_id", b ? b.id : "");
    } catch {}
  }, []);

  const createBinder = useCallback(({ name, pages, grid, color, texture }) => {
    const slotsPerPage = grid.cols * grid.rows;
    const nb = {
      id: Date.now().toString(), name, grid,
      color: color || "#dc2626",
      texture: texture || "leather",
      pages: Array.from({ length: pages }, () => Array(slotsPerPage).fill(null)),
      createdAt: new Date().toISOString(),
    };
    const next = [...binders, nb];
    save(next); setActiveBinder(nb); setCurrentPage(0);
  }, [binders, save]);

  const deleteBinder = useCallback((id) => {
    const next = binders.filter((b) => b.id !== id);
    save(next);
    if (activeBinder?.id === id) { setActiveBinder(null); setCurrentPage(0); }
  }, [binders, save, activeBinder]);

  const updateBinder = useCallback(({ id, name, color, texture }) => {
    const next = binders.map((b) =>
      b.id === id ? { ...b, name, color, texture } : b
    );
    save(next);
    if (activeBinder?.id === id) {
      setActiveBinderRaw((prev) => ({ ...prev, name, color, texture }));
    }
  }, [binders, save, activeBinder]);

  const addCardToSlot = useCallback((pageIndex, slotIndex, card) => {
    if (!activeBinder) return;
    const updated = activeBinder.pages.map((page, pi) =>
      pi === pageIndex ? page.map((slot, si) => (si === slotIndex ? card : slot)) : page
    );
    const ub = { ...activeBinder, pages: updated };
    save(binders.map((b) => (b.id === activeBinder.id ? ub : b)));
    setActiveBinder(ub);
  }, [activeBinder, binders, save]);

  const swapSlots = useCallback(({ srcPage, srcSlot, dstPage, dstSlot }) => {
    if (!activeBinder) return;
    const pages = activeBinder.pages.map(p => [...p]);
    const srcCard = pages[srcPage]?.[srcSlot];
    const dstCard = pages[dstPage]?.[dstSlot];
    if (srcCard === undefined || dstCard === undefined) return;
    pages[srcPage][srcSlot] = dstCard;
    pages[dstPage][dstSlot] = srcCard;
    const ub = { ...activeBinder, pages };
    save(binders.map((b) => (b.id === activeBinder.id ? ub : b)));
    setActiveBinder(ub);
  }, [activeBinder, binders, save]);

  const removeCardFromSlot = useCallback((pi, si) => addCardToSlot(pi, si, null), [addCardToSlot]);

  const getTotalCost = useCallback(() => {
    if (!activeBinder) return 0;
    return activeBinder.pages.flat().filter(Boolean).reduce((acc, card) => {
      const p = card.cardmarket?.prices?.averageSellPrice
        || card.tcgplayer?.prices?.holofoil?.market
        || card.tcgplayer?.prices?.normal?.market || 0;
      return acc + p;
    }, 0);
  }, [activeBinder]);

  return (
    <BinderContext.Provider value={{
      binders, activeBinder, currentPage, setCurrentPage,
      setActiveBinder: (b) => { setActiveBinder(b); setCurrentPage(0); },
      createBinder, deleteBinder, updateBinder, addCardToSlot, swapSlots, removeCardFromSlot, getTotalCost,
    }}>
      {children}
    </BinderContext.Provider>
  );
}

// ─── API ────────────────────────────────────────────────────────────────────
const API_BASE = "/api/v2";

// Cache de sets
let _setsCache = null;
async function getSetsCache() {
  if (_setsCache) return _setsCache;
  const res = await fetch(`${API_BASE}/sets?orderBy=-releaseDate&pageSize=250&select=id,name,series`);
  if (!res.ok) return [];
  _setsCache = (await res.json()).data || [];
  return _setsCache;
}

// Normaliza texto para comparación flexible
function normalize(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

// Tokeniza en palabras únicas de al menos 2 letras
function tokens(str) {
  return normalize(str).split(/\s+/).filter(t => t.length >= 2);
}

// Dado el texto libre, encuentra el set que mejor matchea.
// Estrategia: el set cuyas palabras están más representadas en el input.
// Ej: "eevee prismatic" → "Prismatic Evolutions" tiene 1/2 palabras = 50% → gana si nadie más matchea.
// Ej: "eevee prismatic evolutions" → 2/2 palabras = 100%.
async function detectIntent(raw) {
  if (!raw.trim()) return { cardName: "", setId: null, setName: null };
  const sets = await getSetsCache();
  const inputTokens = tokens(raw);
  if (!inputTokens.length) return { cardName: raw.trim(), setId: null, setName: null };

  let bestSet = null;
  let bestScore = 0;   // proporción de tokens del set que aparecen en el input
  let bestMatched = 0; // cantidad de tokens del set matcheados (desempate)

  for (const s of sets) {
    const setTokens = tokens(s.name);
    if (!setTokens.length) continue;

    // Cuántos tokens del SET aparecen en el INPUT
    // Usamos match estricto: solo prefix si ambos tokens tienen al menos 4 chars
    const matched = setTokens.filter(st =>
      inputTokens.some(it =>
        it === st ||
        (it.startsWith(st) && st.length >= 4) ||
        (st.startsWith(it) && it.length >= 4)
      )
    ).length;
    if (matched === 0) continue;

    const score = matched / setTokens.length; // 1.0 = todas las palabras del set están en el input

    // Gana el que tenga mayor score; en empate, el que tenga más tokens matcheados (set más específico)
    if (score > bestScore || (score === bestScore && matched > bestMatched)) {
      bestSet = s;
      bestScore = score;
      bestMatched = matched;
    }
  }

  // Solo aceptamos el set si al menos el 50% de sus palabras aparecen en el input
  // Para sets cortos (1-2 tokens) exigimos match completo para evitar falsos positivos
  const minScore = bestSet && tokens(bestSet.name).length <= 2 ? 1.0 : 0.5;
  if (bestSet && bestScore >= minScore) {
    // Quitamos del input los tokens que pertenecen al set → lo que queda es el nombre de carta
    const setToks = tokens(bestSet.name);
    const cardTokens = inputTokens.filter(it =>
      !setToks.some(st => it.startsWith(st) || st.startsWith(it))
    );
    const cardName = cardTokens.join(" ");
    return { cardName, setId: bestSet.id, setName: bestSet.name };
  }

  return { cardName: raw.trim(), setId: null, setName: null };
}

function buildFilterParts(filters) {
  const parts = [];
  if (filters.rarity)    parts.push(`rarity:"${filters.rarity}"`);
  if (filters.set)       parts.push(`set.id:"${filters.set}"`);
  if (filters.type)      parts.push(`types:${filters.type}`);
  if (filters.subtype)   parts.push(`subtypes:"${filters.subtype}"`);
  if (filters.supertype) parts.push(`supertype:${filters.supertype}`);
  if (filters.legality)  parts.push(`legalities.${filters.legality}:legal`);
  return parts;
}

async function rawFetch(q, page, pageSize) {
  const params = new URLSearchParams({
    q, page, pageSize,
    select: "id,name,images,set,cardmarket,tcgplayer,rarity,types,subtypes,supertype,number",
    orderBy: "number",
  });
  const res = await fetch(`${API_BASE}/cards?${params}`);
  if (!res.ok) throw new Error("Error al buscar cartas (status " + res.status + ")");
  return res.json();
}

async function searchCards(rawQuery, filters = {}, page = 1, pageSize = 36) {
  const filterParts = buildFilterParts(filters);
  const empty = { data: [], totalCount: 0, page, pageSize };

  // Si hay set en filtro explícito (dropdown), búsqueda directa sin detección
  if (filters.set) {
    const namePart = rawQuery?.trim() ? [`name:"${rawQuery.trim()}*"`] : [];
    const q = [...namePart, ...filterParts].join(" ");
    if (!q) return empty;
    return rawFetch(q, page, pageSize);
  }

  // Sin query ni filtros → vacío
  if (!rawQuery?.trim() && !filterParts.length) return empty;

  // Detección inteligente
  const { cardName, setId } = await detectIntent(rawQuery || "");

  const parts = [];
  if (cardName) parts.push(`name:"${cardName}*"`);
  if (setId)    parts.push(`set.id:"${setId}"`);
  parts.push(...filterParts);

  if (!parts.length) return empty;

  const data = await rawFetch(parts.join(" "), page, pageSize);

  // Fallback: si no encontró nada y hay cardName sin set detectado,
  // intentar con cada token por separado (ej: "gengar holo" → name:"gengar*" name:"holo*")
  if ((data.data || []).length === 0 && cardName && !setId) {
    const toks = cardName.split(/\s+/).filter(t => t.length >= 2);
    if (toks.length > 1) {
      const flexQ = [...toks.map(t => `name:"${t}*"`), ...filterParts].join(" ");
      const flex = await rawFetch(flexQ, page, pageSize);
      if ((flex.data || []).length > 0) return flex;
    }
  }

  return data;
}

async function autocomplete(query, sets = []) {
  if (!query || query.length < 2) return { cards: [], matchedSet: null };
  const inputToks = tokens(query);

  // Buscar el mejor set que matchee (misma lógica que detectIntent)
  const setsData = sets.length ? sets : await getSetsCache();
  let matchedSet = null;
  let bestScore = 0;
  let bestMatched = 0;

  for (const s of setsData) {
    const setToks = tokens(s.name);
    if (!setToks.length) continue;
    const matched = setToks.filter(st => inputToks.some(it => it.startsWith(st) || st.startsWith(it))).length;
    if (matched === 0) continue;
    const score = matched / setToks.length;
    if (score > bestScore || (score === bestScore && matched > bestMatched)) {
      matchedSet = s; bestScore = score; bestMatched = matched;
    }
  }
  if (bestScore < 0.5) matchedSet = null;

  // Cartas: buscar por el primer token que NO pertenezca al set matcheado
  const setToksMatched = matchedSet ? tokens(matchedSet.name) : [];
  const cardTokens = inputToks.filter(it =>
    !setToksMatched.some(st => it.startsWith(st) || st.startsWith(it))
  );
  const searchToken = cardTokens[0] || inputToks[0];

  const params = new URLSearchParams({
    q: `name:"${searchToken}*"`, pageSize: 8,
    select: "id,name,set,images", orderBy: "name",
  });
  const res = await fetch(`${API_BASE}/cards?${params}`);
  const cards = res.ok ? (await res.json()).data || [] : [];
  const seen = new Set();
  const uniqueCards = cards.filter((c) => {
    if (seen.has(c.name)) return false;
    seen.add(c.name); return true;
  });

  return { cards: uniqueCards, matchedSet };
}

async function fetchSets() {
  return getSetsCache();
}

async function fetchRarities() {
  const res = await fetch(`${API_BASE}/rarities`);
  if (!res.ok) return [];
  return (await res.json()).data || [];
}

function getPriceChartingUrl(card) {
  if (!card) return null;
  return `https://www.pricecharting.com/search-products?q=${encodeURIComponent(card.name + " " + (card.set?.name || ""))}&type=pokemon`;
}


// ─── TEXTURE PATTERNS (CSS) ──────────────────────────────────────────────────
const TEXTURES = {
  leather: {
    label: "Cuero",
    emoji: "🟫",
    css: (color) => ({
      backgroundImage: `
        repeating-linear-gradient(
          45deg,
          ${color}22 0px, ${color}22 1px,
          transparent 1px, transparent 8px
        ),
        repeating-linear-gradient(
          -45deg,
          ${color}22 0px, ${color}22 1px,
          transparent 1px, transparent 8px
        )`,
      backgroundSize: "8px 8px",
    }),
  },
  fabric: {
    label: "Tela",
    emoji: "🧵",
    css: (color) => ({
      backgroundImage: `
        repeating-linear-gradient(0deg, ${color}30 0px, ${color}30 1px, transparent 1px, transparent 4px),
        repeating-linear-gradient(90deg, ${color}30 0px, ${color}30 1px, transparent 1px, transparent 4px)`,
      backgroundSize: "4px 4px",
    }),
  },
  carbon: {
    label: "Carbon",
    emoji: "⬛",
    css: (color) => ({
      backgroundImage: `
        repeating-linear-gradient(
          45deg,
          rgba(0,0,0,0.3) 0px, rgba(0,0,0,0.3) 2px,
          transparent 2px, transparent 6px
        ),
        repeating-linear-gradient(
          -45deg,
          rgba(255,255,255,0.05) 0px, rgba(255,255,255,0.05) 2px,
          transparent 2px, transparent 6px
        )`,
      backgroundSize: "6px 6px",
    }),
  },
  smooth: {
    label: "Liso",
    emoji: "⬜",
    css: () => ({}),
  },
};

// Genera el CSS inline del lomo/tapa dado un binder
function getBinderStyle(binder) {
  const color = binder?.color || "#dc2626";
  const texture = TEXTURES[binder?.texture || "leather"];
  return {
    backgroundColor: color,
    ...texture.css(color),
  };
}

// Color oscurecido para sombras/bordes
function darken(hex, amount = 40) {
  let c = hex.replace("#", "");
  if (c.length === 3) c = c.split("").map(x => x + x).join("");
  const num = parseInt(c, 16);
  const r = Math.max(0, (num >> 16) - amount);
  const g = Math.max(0, ((num >> 8) & 0xff) - amount);
  const b = Math.max(0, (num & 0xff) - amount);
  return `rgb(${r},${g},${b})`;
}

function lighten(hex, amount = 60) {
  let c = hex.replace("#", "");
  if (c.length === 3) c = c.split("").map(x => x + x).join("");
  const num = parseInt(c, 16);
  const r = Math.min(255, (num >> 16) + amount);
  const g = Math.min(255, ((num >> 8) & 0xff) + amount);
  const b = Math.min(255, (num & 0xff) + amount);
  return `rgb(${r},${g},${b})`;
}

// ─── ICONS ──────────────────────────────────────────────────────────────────
const Icon = {
  Plus: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M12 5v14M5 12h14" strokeLinecap="round" /></svg>,
  Trash: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  Search: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" strokeLinecap="round" /></svg>,
  ChevronLeft: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  ChevronRight: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  Download: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  X: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" /></svg>,
  Book: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M4 19.5A2.5 2.5 0 016.5 17H20" strokeLinecap="round" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" strokeLinecap="round" /></svg>,
  Filter: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" strokeLinejoin="round" /></svg>,
  Dollar: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" strokeLinecap="round" /></svg>,
  Pokeball: (p) => <svg {...p} viewBox="0 0 100 100" fill="none"><circle cx="50" cy="50" r="48" fill="currentColor" opacity="0.12" stroke="currentColor" strokeWidth="4"/><path d="M2 50 Q2 2 50 2 Q98 2 98 50" fill="currentColor" opacity="0.9"/><path d="M2 50 Q2 98 50 98 Q98 98 98 50" fill="white" opacity="0.15"/><rect x="2" y="46" width="96" height="8" fill="currentColor" opacity="0.8"/><circle cx="50" cy="50" r="14" fill="white" stroke="currentColor" strokeWidth="4"/><circle cx="50" cy="50" r="7" fill="currentColor" opacity="0.4"/></svg>,
  ChevronDown: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  Layers: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></svg>,
  ZoomIn: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" strokeLinecap="round" /><path d="M11 8v6M8 11h6" strokeLinecap="round" /></svg>,
  ExternalLink: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" strokeLinecap="round" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>,
  Edit: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" strokeLinecap="round" strokeLinejoin="round"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  Menu: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M3 12h18M3 6h18M3 18h18" strokeLinecap="round"/></svg>,
  Ring: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" fill="currentColor" opacity="0.3" /></svg>,
  Palette: (p) => <svg {...p} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8z" /><circle cx="6.5" cy="11.5" r="1.5" fill="currentColor" /><circle cx="9.5" cy="7.5" r="1.5" fill="currentColor" /><circle cx="14.5" cy="7.5" r="1.5" fill="currentColor" /><circle cx="17.5" cy="11.5" r="1.5" fill="currentColor" /></svg>,
};

// ─── HELPERS ────────────────────────────────────────────────────────────────
function getCardPrice(card) {
  return card?.cardmarket?.prices?.averageSellPrice
    || card?.tcgplayer?.prices?.holofoil?.market
    || card?.tcgplayer?.prices?.normal?.market
    || null;
}

// ─── BINDER COLOR PRESETS ────────────────────────────────────────────────────
const COLOR_PRESETS = [
  { color: "#dc2626", label: "Rojo" },
  { color: "#2563eb", label: "Azul" },
  { color: "#16a34a", label: "Verde" },
  { color: "#9333ea", label: "Violeta" },
  { color: "#ea580c", label: "Naranja" },
  { color: "#0891b2", label: "Celeste" },
  { color: "#be185d", label: "Rosa" },
  { color: "#ca8a04", label: "Dorado" },
  { color: "#475569", label: "Gris" },
  { color: "#1e1e1e", label: "Negro" },
];

// ─── CREATE BINDER MODAL ────────────────────────────────────────────────────
function CreateBinderModal({ onClose }) {
  const { createBinder } = useBinder();
  const [name, setName] = useState("");
  const [pages, setPages] = useState(10);
  const [cols, setCols] = useState(4);
  const [rows, setRows] = useState(3);
  const [color, setColor] = useState("#dc2626");
  const [texture, setTexture] = useState("leather");

  const handleCreate = () => {
    if (!name.trim()) return;
    createBinder({ name: name.trim(), pages, grid: { cols, rows, label: `${cols}×${rows}` }, color, texture });
    onClose();
  };

  const binderStyle = getBinderStyle({ color, texture });
  const darkColor = darken(color, 50);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-lg p-6 shadow-2xl mx-4 max-h-screen overflow-y-auto">
        <h2 className="text-xl font-bold text-white mb-6 flex items-center gap-2">
          <Icon.Book className="w-5 h-5 text-red-500" /> Nuevo Binder
        </h2>

        <div className="space-y-5">
          {/* Nombre */}
          <div>
            <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Nombre</label>
            <input
              autoFocus
              className="w-full bg-zinc-800 border border-zinc-600 rounded-xl px-4 py-3 text-white placeholder-zinc-500 focus:outline-none focus:border-red-500 transition-colors"
              placeholder="Ej: Mi colección de Charizard"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
          </div>

          {/* Color */}
          <div>
            <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 flex items-center gap-1">
              <Icon.Palette className="w-3.5 h-3.5" /> Color de tapa
            </label>
            <div className="flex flex-wrap gap-2 mb-2">
              {COLOR_PRESETS.map(({ color: c, label }) => (
                <button key={c} title={label} onClick={() => setColor(c)}
                  className={`w-7 h-7 rounded-full border-2 transition-all hover:scale-110 ${color === c ? "border-white scale-110" : "border-transparent"}`}
                  style={{ backgroundColor: c }} />
              ))}
              {/* Custom color picker */}
              <label className="relative w-7 h-7 rounded-full border-2 border-dashed border-zinc-500 hover:border-white transition-colors cursor-pointer flex items-center justify-center overflow-hidden" title="Color personalizado">
                <span className="text-zinc-400 text-xs">+</span>
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)}
                  className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" />
              </label>
            </div>
          </div>

          {/* Textura */}
          <div>
            <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Textura</label>
            <div className="flex gap-2 flex-wrap">
              {Object.entries(TEXTURES).map(([key, tx]) => (
                <button key={key} onClick={() => setTexture(key)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${texture === key ? "border-red-500 bg-red-500/15 text-red-300" : "border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-500"}`}>
                  {tx.emoji} {tx.label}
                </button>
              ))}
            </div>
          </div>

          {/* Preview binder */}
          <div className="p-4 bg-zinc-950 rounded-xl border border-zinc-800">
            <p className="text-xs text-zinc-600 mb-3">Vista previa del binder</p>
            <div className="flex items-stretch gap-0 h-28 max-w-xs mx-auto rounded-lg overflow-hidden shadow-2xl"
              style={{ filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.6))" }}>
              {/* Lomo */}
              <div className="w-7 flex flex-col items-center justify-center gap-1 rounded-l-lg"
                style={{ backgroundColor: darkColor, boxShadow: `inset -2px 0 6px rgba(0,0,0,0.4)` }}>
                {[0,1,2].map(i => (
                  <div key={i} className="w-3 h-3 rounded-full border-2 border-white/20"
                    style={{ backgroundColor: "rgba(255,255,255,0.1)" }} />
                ))}
              </div>
              {/* Tapa */}
              <div className="flex-1 flex flex-col items-center justify-center rounded-r-lg relative overflow-hidden"
                style={binderStyle}>
                <div className="absolute inset-0" style={{ backgroundColor: `${color}dd` }} />
                <div className="relative z-10 text-white text-xs font-bold text-center px-2 truncate w-full text-center"
                  style={{ textShadow: "0 1px 4px rgba(0,0,0,0.5)" }}>
                  {name || "Nombre del binder"}
                </div>
              </div>
            </div>
          </div>

          {/* Páginas */}
          <div>
            <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
              Páginas: <span className="text-red-400">{pages}</span>
            </label>
            <input type="range" min={1} max={50} value={pages} onChange={(e) => setPages(+e.target.value)} className="w-full accent-red-500" />
            <div className="flex justify-between text-xs text-zinc-600 mt-1"><span>1</span><span>50</span></div>
          </div>

          {/* Grilla */}
          <div>
            <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
              Grilla: <span className="text-red-400">{cols}×{rows}</span>
              <span className="ml-2 text-zinc-600 normal-case font-normal">({cols * rows} cartas/pág)</span>
            </label>
            <div className="grid grid-cols-2 gap-4 mb-3">
              {[["Columnas", cols, setCols, 1, 8], ["Filas", rows, setRows, 1, 6]].map(([label, val, setter, min, max]) => (
                <div key={label}>
                  <p className="text-xs text-zinc-500 mb-2">{label}</p>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setter((v) => Math.max(min, v - 1))} className="w-8 h-8 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white font-bold transition-colors">−</button>
                    <span className="w-8 text-center text-white font-bold">{val}</span>
                    <button onClick={() => setter((v) => Math.min(max, v + 1))} className="w-8 h-8 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white font-bold transition-colors">+</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3">
              <p className="text-xs text-zinc-500 mb-2">Presets rápidos</p>
              <div className="flex gap-1.5 flex-wrap">
                {[[2,2],[3,3],[4,3],[4,4],[5,4],[6,4]].map(([c,r]) => (
                  <button key={`${c}x${r}`} onClick={() => { setCols(c); setRows(r); }}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${cols===c&&rows===r ? "bg-red-600 text-white" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}>
                    {c}×{r}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="flex gap-3 mt-8">
          <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-zinc-600 text-zinc-300 hover:bg-zinc-800 transition-colors font-semibold">Cancelar</button>
          <button onClick={handleCreate} disabled={!name.trim()} className="flex-1 py-3 rounded-xl bg-red-600 text-white font-bold hover:bg-red-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            Crear Binder
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── AUTOCOMPLETE INPUT ─────────────────────────────────────────────────────
// Input de búsqueda: busca solo al presionar Enter
function SearchInput({ value, onChange, onSearch, placeholder }) {
  return (
    <input
      autoFocus
      className="flex-1 bg-zinc-800 border border-zinc-600 rounded-xl px-4 py-2.5 text-white placeholder-zinc-500 focus:outline-none focus:border-red-500 transition-colors"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") onSearch(value); }}
    />
  );
}

// ─── FILTER PANEL ───────────────────────────────────────────────────────────
const TYPES = ["Colorless","Darkness","Dragon","Fairy","Fighting","Fire","Grass","Lightning","Metal","Psychic","Water"];
const SUPERTYPES = ["Pokémon","Trainer","Energy"];
const SUBTYPES = ["Basic","Stage 1","Stage 2","GX","EX","V","VMAX","VSTAR","ex","Mega","Prism Star","TAG TEAM","Item","Supporter","Stadium","Special","Basic Energy","Special Energy"];
const LEGALITIES = [{value:"standard",label:"Standard"},{value:"expanded",label:"Expanded"},{value:"unlimited",label:"Unlimited"}];

// Selector de set con buscador interno
function SetSelector({ value, onChange, sets }) {
  const [setSearch, setSetSearch] = useState("");
  const filtered = sets.filter(s =>
    normalize(s.name).includes(normalize(setSearch)) ||
    normalize(s.series).includes(normalize(setSearch))
  );
  const selected = sets.find(s => s.id === value);

  return (
    <div>
      <label className="block text-xs text-zinc-400 mb-1 font-medium">Set / Expansión</label>
      <div className="bg-zinc-800 border border-zinc-700 rounded-lg overflow-hidden focus-within:border-red-500 transition-colors">
        <div className="flex items-center gap-2 px-2 py-1.5 border-b border-zinc-700">
          <Icon.Search className="w-3 h-3 text-zinc-500 flex-shrink-0" />
          <input
            className="flex-1 bg-transparent text-xs text-white placeholder-zinc-500 focus:outline-none"
            placeholder="Buscar set..."
            value={setSearch}
            onChange={e => setSetSearch(e.target.value)}
          />
          {setSearch && (
            <button onClick={() => setSetSearch("")} className="text-zinc-600 hover:text-zinc-400">
              <Icon.X className="w-3 h-3" />
            </button>
          )}
        </div>
        <div className="overflow-y-auto" style={{ maxHeight: "120px" }}>
          <button
            onMouseDown={() => onChange("")}
            className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${!value ? "bg-red-600/20 text-red-300" : "text-zinc-400 hover:bg-zinc-700"}`}>
            Todos los sets
          </button>
          {filtered.map(s => (
            <button key={s.id}
              onMouseDown={() => onChange(s.id)}
              className={`w-full text-left px-3 py-1.5 text-xs transition-colors truncate ${value === s.id ? "bg-red-600/20 text-red-300" : "text-zinc-300 hover:bg-zinc-700"}`}
              title={s.name}>
              {s.name}
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="px-3 py-2 text-xs text-zinc-600">Sin resultados</p>
          )}
        </div>
        {selected && (
          <div className="px-3 py-1 border-t border-zinc-700 text-[10px] text-red-400 truncate">{selected.name}</div>
        )}
      </div>
    </div>
  );
}

function FilterPanel({ filters, onChange, sets, rarities, onClear, activeCount }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const Sel = ({ label, field, options }) => (
    <div>
      <label className="block text-xs text-zinc-400 mb-1 font-medium">{label}</label>
      <div className="relative">
        <select value={filters[field] || ""} onChange={(e) => onChange({ ...filters, [field]: e.target.value })}
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white appearance-none focus:outline-none focus:border-red-500 pr-7">
          <option value="">Todos</option>
          {options.map((o) => <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>)}
        </select>
        <Icon.ChevronDown className="w-3.5 h-3.5 text-zinc-500 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
      </div>
    </div>
  );

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium transition-all h-full ${
          activeCount > 0 ? "bg-red-500/20 border-red-500/50 text-red-400" : "bg-zinc-800 border-zinc-600 text-zinc-300 hover:border-zinc-400"
        }`}>
        <Icon.Filter className="w-4 h-4" />
        <span className="hidden sm:inline">Filtros</span>
        {activeCount > 0 && <span className="bg-red-500 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center leading-none">{activeCount}</span>}
      </button>
      {open && (
        <div className="absolute top-full mt-2 right-0 bg-zinc-900 border border-zinc-700 rounded-xl p-4 z-50 shadow-2xl w-[560px] flex flex-col gap-3">
          {/* Raridades especiales rápidas */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5 font-medium">Arte especial</label>
            <div className="flex flex-wrap gap-1.5">
              {[
                ["Illustration Rare", "AR 🎨"],
                ["Special Illustration Rare", "SIR ✨"],
                ["Double Rare", "IR 💠"],
                ["Special Art Rare", "SAR 🌟"],
                ["ACE SPEC Rare", "ACE ♠"],
                ["Full Art", "FA 🖼"],
                ["Hyper Rare", "HR 💎"],
                ["Shiny Rare", "Shiny ⭐"],
                ["Shiny Ultra Rare", "Shiny UR 🌠"],
              ].map(([val, label]) => (
                <button key={val}
                  onMouseDown={() => onChange({ ...filters, rarity: filters.rarity === val ? "" : val })}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all ${
                    filters.rarity === val
                      ? "bg-red-600/30 border-red-500 text-red-300"
                      : "bg-zinc-800 border-zinc-700 text-zinc-300 hover:border-zinc-500"
                  }`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
          <Sel label="Rareza (todas)" field="rarity" options={rarities.map((r) => ({ value: r, label: r }))} />
          <SetSelector value={filters.set || ""} onChange={(v) => onChange({ ...filters, set: v })} sets={sets} />
          <Sel label="Tipo de energía" field="type" options={TYPES} />
          <Sel label="Supertipo" field="supertype" options={SUPERTYPES} />
          <Sel label="Subtipo" field="subtype" options={SUBTYPES} />
          <Sel label="Legalidad" field="legality" options={LEGALITIES} />
          </div>
          <div className="flex justify-between items-center pt-1 border-t border-zinc-800">
            <span className="text-xs text-zinc-500">{activeCount} filtro{activeCount !== 1 ? "s" : ""} activo{activeCount !== 1 ? "s" : ""}</span>
            <div className="flex gap-2">
              {activeCount > 0 && (
                <button onClick={() => { onClear(); setOpen(false); }} className="px-3 py-1.5 text-xs text-zinc-400 hover:text-white transition-colors">Limpiar todo</button>
              )}
              <button onClick={() => setOpen(false)} className="px-4 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs rounded-lg transition-colors font-medium">Aplicar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── CARD SEARCH PANEL ───────────────────────────────────────────────────────
const PAGE_SIZE = 36;

function CardSearchPanel({ targetSlot, onClose }) {
  const { addCardToSlot } = useBinder();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searched, setSearched] = useState(false);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [filters, setFilters] = useState({});
  const [sets, setSets] = useState([]);
  const [rarities, setRarities] = useState([]);

  const activeFilterCount = useMemo(() => Object.values(filters).filter(Boolean).length, [filters]);

  useEffect(() => {
    fetchSets().then(setSets);
    fetchRarities().then(setRarities);
  }, []);

  const doSearch = useCallback(async (q, f, p) => {
    const hasQuery = q?.trim() || Object.values(f).some(Boolean);
    if (!hasQuery) return;
    setLoading(true); setError(null); setSearched(true);
    try {
      const data = await searchCards(q, f, p, PAGE_SIZE);
      setResults(data.data || []);
      setTotalCount(data.totalCount || 0);
    } catch (e) {
      setError(e.message); setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSearch = (q) => { const sq = (q !== undefined ? q : query); setPage(1); doSearch(sq, filters, 1); };
  const handleFilterChange = (nf) => { setFilters(nf); setPage(1); doSearch(query, nf, 1); };
  const handlePageChange = (np) => { setPage(np); doSearch(query, filters, np); };
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  const pageButtons = useMemo(() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    if (page <= 4) return [1, 2, 3, 4, 5, "...", totalPages];
    if (page >= totalPages - 3) return [1, "...", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    return [1, "...", page - 1, page, page + 1, "...", totalPages];
  }, [page, totalPages]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-700 rounded-t-3xl sm:rounded-2xl w-full max-w-3xl max-h-[92vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between p-4 border-b border-zinc-800 shrink-0">
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <Icon.Search className="w-4 h-4 text-red-500" /> Buscar carta
            </h2>
            {totalCount > 0 && <p className="text-xs text-zinc-500 mt-0.5">{totalCount.toLocaleString()} resultados · pág {page}/{totalPages}</p>}
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-white transition-colors p-1.5 rounded-lg hover:bg-zinc-800">
            <Icon.X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-3 border-b border-zinc-800 shrink-0 flex gap-2">
          <SearchInput value={query} onChange={setQuery} onSearch={handleSearch} placeholder="Ej: Gengar, Prismatic Evolutions, Eevee Prismatic..." />
          <FilterPanel filters={filters} onChange={handleFilterChange} sets={sets} rarities={rarities} onClear={() => handleFilterChange({})} activeCount={activeFilterCount} />
          <button onClick={() => handleSearch()} disabled={loading}
            className="px-4 py-2.5 bg-red-600 text-white rounded-xl font-bold hover:bg-red-500 transition-colors disabled:opacity-40 shrink-0">
            {loading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Icon.Search className="w-5 h-5" />}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {!searched && (
            <div className="flex flex-col items-center justify-center h-40 text-zinc-600">
              <Icon.Pokeball className="w-10 h-10 opacity-30 text-zinc-500" />
              <p className="mt-2 text-sm">Buscá por nombre o aplicá filtros</p>
              <p className="text-xs text-zinc-700 mt-1">Podés buscar "Gengar Base Set" o "Charizard 151"</p>
            </div>
          )}
          {error && <div className="text-red-400 bg-red-900/20 rounded-xl p-4 text-sm">⚠️ {error}</div>}
          {searched && !loading && !error && results.length === 0 && (
            <div className="text-center text-zinc-500 py-12 text-sm">No se encontraron cartas.</div>
          )}
          {loading && (
            <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
              {Array(18).fill(null).map((_, i) => <div key={i} className="aspect-[2.5/3.5] bg-zinc-800 rounded-lg animate-pulse" />)}
            </div>
          )}
          {!loading && results.length > 0 && (
            <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
              {results.map((card) => {
                const price = getCardPrice(card);
                const pcUrl = getPriceChartingUrl(card);
                return (
                  <button key={card.id}
                    onClick={() => { addCardToSlot(targetSlot.pageIndex, targetSlot.slotIndex, card); onClose(); }}
                    title={`${card.name} — ${card.set?.name}${price ? ` — $${price.toFixed(2)}` : ""}`}
                    className="group relative rounded-lg overflow-hidden border border-zinc-700 hover:border-red-500 transition-all hover:scale-[1.04] hover:shadow-lg hover:shadow-red-900/40 focus:outline-none">
                    <img src={card.images?.small} alt={card.name} className="w-full aspect-[2.5/3.5] object-cover block" loading="lazy" />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/70 transition-colors flex flex-col items-center justify-end pb-1 gap-0.5 opacity-0 group-hover:opacity-100">
                      <p className="text-white text-[9px] font-semibold text-center px-1 leading-tight">{card.name}</p>
                      <p className="text-zinc-400 text-[8px] text-center leading-tight">{card.set?.name}</p>
                      {price && (
                        <a href={pcUrl} target="_blank" rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-red-400 text-[9px] font-bold hover:text-red-300 hover:underline flex items-center gap-0.5">
                          ${price.toFixed(2)} <Icon.ExternalLink className="w-2 h-2" />
                        </a>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-zinc-800 shrink-0 gap-2">
            <button onClick={() => handlePageChange(page - 1)} disabled={page === 1 || loading}
              className="flex items-center gap-1 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-white text-xs rounded-lg disabled:opacity-30 transition-colors font-medium">
              <Icon.ChevronLeft className="w-3.5 h-3.5" /> Ant.
            </button>
            <div className="flex items-center gap-1">
              {pageButtons.map((p, i) =>
                p === "..." ? (
                  <span key={`d${i}`} className="text-zinc-600 text-xs px-1">…</span>
                ) : (
                  <button key={p} onClick={() => handlePageChange(p)}
                    className={`w-7 h-7 rounded-lg text-xs font-bold transition-colors ${p === page ? "bg-red-600 text-white" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}>
                    {p}
                  </button>
                )
              )}
            </div>
            <button onClick={() => handlePageChange(page + 1)} disabled={page === totalPages || loading}
              className="flex items-center gap-1 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-white text-xs rounded-lg disabled:opacity-30 transition-colors font-medium">
              Sig. <Icon.ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── DRAG & DROP ─────────────────────────────────────────────────────────────
// Referencia global para el slot que se está arrastrando
const dragSource = { pageIndex: null, slotIndex: null };

// ─── CARD SLOT ───────────────────────────────────────────────────────────────
function CardSlot({ card, pageIndex, slotIndex, onAdd }) {
  const { removeCardFromSlot } = useBinder();
  const [hovered, setHovered] = useState(false);

  if (card) {
    const price = getCardPrice(card);
    const pcUrl = getPriceChartingUrl(card);
    return (
      <div className="relative rounded overflow-hidden border border-zinc-600/40 hover:border-red-500/60 transition-all shadow-sm"
        style={{ aspectRatio: "2.5/3.5", width: "100%", cursor: "grab" }}
        draggable
        onDragStart={(e) => {
          dragSource.pageIndex = pageIndex;
          dragSource.slotIndex = slotIndex;
          e.dataTransfer.effectAllowed = "move";
          // Imagen semitransparente al arrastrar
          e.dataTransfer.setDragImage(e.currentTarget, e.currentTarget.offsetWidth / 2, e.currentTarget.offsetHeight / 2);
        }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
        onDrop={(e) => {
          e.preventDefault();
          const { pageIndex: srcPage, slotIndex: srcSlot } = dragSource;
          if (srcPage === null || (srcPage === pageIndex && srcSlot === slotIndex)) return;
          // Intercambiar las cartas entre slots usando addCardToSlot
          const srcCard = card; // la carta del destino
          // Necesitamos acceder al binder — lo hacemos a través del contexto
          document.dispatchEvent(new CustomEvent("vb:swapSlots", {
            detail: { srcPage, srcSlot, dstPage: pageIndex, dstSlot: slotIndex }
          }));
          dragSource.pageIndex = null; dragSource.slotIndex = null;
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}>
        <img src={card.images?.small} alt={card.name} className="w-full h-full object-cover" draggable={false} />
        <div className={`absolute inset-0 flex flex-col items-center justify-center gap-1.5 transition-opacity p-2 ${hovered ? "opacity-100" : "opacity-0"}`}
          style={{ backdropFilter: "blur(6px)", backgroundColor: "rgba(0,0,0,0.72)" }}>
          <p className="text-white text-[11px] font-bold text-center leading-tight drop-shadow px-1">{card.name}</p>
          <p className="text-zinc-300 text-[9px] text-center leading-tight px-1">{card.set?.name}</p>
          {price ? (
            <a href={pcUrl} target="_blank" rel="noopener noreferrer"
              className="text-red-400 text-[11px] font-bold hover:text-red-300 hover:underline flex items-center gap-0.5 mt-0.5">
              ${price.toFixed(2)} <Icon.ExternalLink className="w-2.5 h-2.5" />
            </a>
          ) : (
            <a href={pcUrl} target="_blank" rel="noopener noreferrer"
              className="text-zinc-400 text-[9px] hover:text-zinc-200 flex items-center gap-0.5 mt-0.5">
              Ver precio <Icon.ExternalLink className="w-2 h-2" />
            </a>
          )}
          <button onClick={() => removeCardFromSlot(pageIndex, slotIndex)}
            className="mt-1 p-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors">
            <Icon.X className="w-3 h-3" />
          </button>
        </div>
      </div>
    );
  }

  const [dragOver, setDragOver] = useState(false);
  return (
    <button onClick={() => onAdd(pageIndex, slotIndex)}
      style={{ aspectRatio: "2.5/3.5", width: "100%" }}
      className={`rounded border border-dashed transition-all flex items-center justify-center group ${
        dragOver ? "border-red-500 bg-red-500/10" : "border-zinc-600/30 hover:border-red-500/50 hover:bg-red-500/5"
      }`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault(); setDragOver(false);
        const { pageIndex: srcPage, slotIndex: srcSlot } = dragSource;
        if (srcPage === null) return;
        document.dispatchEvent(new CustomEvent("vb:swapSlots", {
          detail: { srcPage, srcSlot, dstPage: pageIndex, dstSlot: slotIndex }
        }));
        dragSource.pageIndex = null; dragSource.slotIndex = null;
      }}>
      <Icon.Plus className="w-4 h-4 text-zinc-700 group-hover:text-red-500 transition-colors" />
    </button>
  );
}

// ─── RINGS (decoración de anillas) ──────────────────────────────────────────
function BinderRings({ color, count = 3 }) {
  const darkC = darken(color, 60);
  return (
    <div className="flex flex-col items-center justify-around h-full py-4 px-1">
      {Array(count).fill(null).map((_, i) => (
        <div key={i} className="relative w-5 h-5">
          {/* Ring shadow */}
          <div className="absolute inset-0 rounded-full" style={{ backgroundColor: darkC, transform: "scale(1.1)" }} />
          {/* Ring body */}
          <div className="absolute inset-0 rounded-full border-4" style={{
            borderColor: lighten(color, 30),
            background: `radial-gradient(circle at 35% 35%, ${lighten(color, 80)}, ${lighten(color, 20)})`,
            boxShadow: `inset 0 2px 4px rgba(0,0,0,0.4), 0 1px 2px rgba(255,255,255,0.15)`,
          }} />
          {/* Ring hole */}
          <div className="absolute inset-[5px] rounded-full" style={{ backgroundColor: "#111" }} />
        </div>
      ))}
    </div>
  );
}

// ─── BINDER PAGE VIEW ────────────────────────────────────────────────────────
function BinderPageView({ onAddCard }) {
  const { activeBinder, currentPage, setCurrentPage, swapSlots } = useBinder();
  const containerRef = useRef(null);
  const [zoom, setZoom] = useState(0.65);
  useEffect(() => {
    const handler = (e) => swapSlots(e.detail);
    document.addEventListener("vb:swapSlots", handler);
    return () => document.removeEventListener("vb:swapSlots", handler);
  }, [swapSlots]);

  // Auto-fit zoom: mide el contenedor real y calcula el zoom para que la página entre
  useEffect(() => {
    const fit = () => {
      if (!containerRef.current) return;
      const box = containerRef.current.getBoundingClientRect();
      // Descuentos fijos: topbar de pag (~32px) + navegación (~56px) + gaps (~20px)
      const availH = box.height - 108;
      const availW = box.width - 40;
      if (availH <= 0 || availW <= 0) return;

      // El binder tiene aspect ratio de carta aprox: ancho / (ancho * ratio_pagina)
      // Una página de binder es aprox 1.41 veces más alta que ancha (similar A4)
      const pageRatio = 1.41;

      // Zoom que hace que el alto entre exacto en el espacio disponible
      // Alto del binder a zoom 100% = availW * pageRatio
      const zoomByH = availH / (availW * pageRatio);

      // Limitamos el zoom máximo al 85% para no ocupar todo el ancho
      const ideal = Math.min(zoomByH, 0.85);
      setZoom(Math.min(Math.max(ideal, 0.4), 1.0));
    };

    // Esperar un tick para que el DOM tenga dimensiones reales
    const timer = setTimeout(fit, 50);
    const obs = new ResizeObserver(fit);
    if (containerRef.current) obs.observe(containerRef.current);
    return () => { clearTimeout(timer); obs.disconnect(); };
  }, [activeBinder?.id]);

  if (!activeBinder) return null;
  const { pages, grid, color = "#dc2626", texture = "leather" } = activeBinder;
  const page = pages[currentPage];
  const binderStyle = getBinderStyle(activeBinder);
  const darkC = darken(color, 50);
  const lightC = lighten(color, 20);

  return (
    <div ref={containerRef} className="flex flex-col gap-3 h-full">
      {/* Top bar */}
      <div className="flex items-center justify-between shrink-0">
        <span className="text-sm text-zinc-400">
          Pág <span className="text-white font-semibold">{currentPage + 1}</span>/{pages.length}
          <span className="ml-2 text-zinc-600 text-xs">{grid.label} · {page.filter(Boolean).length}/{page.length}</span>
        </span>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Icon.ZoomIn className="w-3.5 h-3.5 text-zinc-500" />
            <input type="range" min={30} max={100} value={Math.round(zoom * 100)}
              onChange={(e) => setZoom(+e.target.value / 100)}
              className="w-20 accent-red-500" />
            <span className="text-xs text-zinc-500 w-8">{Math.round(zoom * 100)}%</span>
          </div>
          <div className="flex gap-1 flex-wrap justify-end max-w-xs">
            {pages.map((pg, i) => (
              <button key={i} onClick={() => setCurrentPage(i)} title={`Pág ${i + 1}`}
                className={`h-1.5 rounded-full transition-all ${i === currentPage ? "w-4" : pg.filter(Boolean).length > 0 ? "w-1.5 bg-zinc-500" : "w-1.5 bg-zinc-700"}`}
                style={i === currentPage ? { width: "1rem", backgroundColor: color } : {}}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ── BINDER BODY ── */}
      <div className="flex justify-center">
        <div style={{ width: `${zoom * 100}%`, maxWidth: "100%" }}>
          {/* Binder outer shell */}
          <div className="flex rounded-r-xl overflow-hidden shadow-2xl"
            style={{
              filter: `drop-shadow(0 16px 40px rgba(0,0,0,0.7))`,
              minHeight: "200px",
            }}>
            {/* LOMO */}
            <div className="w-10 flex-shrink-0 flex flex-col relative overflow-hidden rounded-l-sm"
              style={{
                background: `linear-gradient(to right, ${darkC}, ${color} 40%, ${lightC} 60%, ${color})`,
                boxShadow: `inset -3px 0 8px rgba(0,0,0,0.5), inset 2px 0 4px rgba(255,255,255,0.1)`,
                ...TEXTURES[texture].css(darkC),
              }}>
              {/* Binder rings */}
              <BinderRings color={color} count={Math.min(5, Math.max(3, Math.ceil(pages.length / 4)))} />
            </div>

            {/* TAPA izquierda (fina) */}
            <div className="w-3 flex-shrink-0" style={{
              background: `linear-gradient(to right, ${color}, ${lighten(color, 15)})`,
              boxShadow: `inset -1px 0 4px rgba(0,0,0,0.3)`,
            }} />

            {/* PÁGINA */}
            <div className="flex-1 relative"
              style={{
                background: "linear-gradient(135deg, #1c1c1f 0%, #18181b 50%, #1a1a1e 100%)",
                boxShadow: `inset 4px 0 12px rgba(0,0,0,0.4), inset -1px 0 4px rgba(0,0,0,0.2)`,
              }}>
              {/* Page texture overlay */}
              <div className="absolute inset-0 opacity-[0.03] pointer-events-none"
                style={{
                  backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 27px, rgba(255,255,255,0.5) 27px, rgba(255,255,255,0.5) 28px)",
                  backgroundSize: "100% 28px",
                }} />

              {/* Page number tab */}
              <div className="absolute top-3 right-3 pointer-events-none text-[9px] font-bold px-2 py-0.5 rounded-full"
                style={{ backgroundColor: `${color}33`, color: lightC, border: `1px solid ${color}44` }}>
                {currentPage + 1}/{pages.length}
              </div>

              {/* Card grid */}
              <div className="p-4 pt-8">
                <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${grid.cols}, 1fr)` }}>
                  {page.map((card, slotIndex) => (
                    <CardSlot key={slotIndex} card={card} pageIndex={currentPage} slotIndex={slotIndex} onAdd={onAddCard} />
                  ))}
                </div>
              </div>
            </div>

            {/* TAPA derecha (fina) */}
            <div className="w-3 flex-shrink-0 rounded-r-sm" style={{
              background: `linear-gradient(to right, ${lighten(color, 15)}, ${color})`,
              boxShadow: `inset 1px 0 4px rgba(0,0,0,0.3)`,
            }} />
          </div>
        </div>
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between shrink-0 pt-1">
        <button onClick={() => setCurrentPage((p) => Math.max(0, p - 1))} disabled={currentPage === 0}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white disabled:opacity-30 transition-colors text-sm font-medium">
          <Icon.ChevronLeft className="w-4 h-4" /> Anterior
        </button>
        <button onClick={() => setCurrentPage((p) => Math.min(pages.length - 1, p + 1))} disabled={currentPage === pages.length - 1}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white disabled:opacity-30 transition-colors text-sm font-medium">
          Siguiente <Icon.ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ─── STATS BAR ───────────────────────────────────────────────────────────────
function BinderStatsBar({ onExport }) {
  const { activeBinder, getTotalCost } = useBinder();
  if (!activeBinder) return null;
  const allCards = activeBinder.pages.flat().filter(Boolean);
  const totalSlots = activeBinder.pages.flat().length;
  const fillPct = Math.round((allCards.length / totalSlots) * 100);
  const cost = getTotalCost();
  const color = activeBinder.color || "#dc2626";

  return (
    <div className="flex flex-wrap items-center gap-4 px-5 py-2.5 bg-zinc-900/80 border-b border-zinc-800 shrink-0">
      <div className="flex items-center gap-2 text-sm">
        <Icon.Layers className="w-4 h-4 text-zinc-500" />
        <span className="text-zinc-400">Cartas:</span>
        <span className="text-white font-semibold">{allCards.length}<span className="text-zinc-600">/{totalSlots}</span></span>
      </div>
      <div className="flex items-center gap-2">
        <div className="h-1.5 w-20 bg-zinc-800 rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all" style={{ width: `${fillPct}%`, backgroundColor: color }} />
        </div>
        <span className="text-zinc-500 text-xs">{fillPct}%</span>
      </div>
      <div className="flex items-center gap-1.5 text-sm">
        <Icon.Dollar className="w-4 h-4 text-zinc-500" />
        <span className="text-zinc-400">Valor:</span>
        <span className="font-bold" style={{ color }}>${cost.toFixed(2)}<span className="text-zinc-600 font-normal text-xs ml-1">USD</span></span>
      </div>
      <button onClick={onExport}
        className="ml-auto flex items-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 hover:border-zinc-500 text-white text-sm rounded-lg transition-all font-medium">
        <Icon.Download className="w-4 h-4" /> Exportar PDF
      </button>
    </div>
  );
}


// ─── EDIT BINDER MODAL ───────────────────────────────────────────────────────
function EditBinderModal({ binder, onClose }) {
  const { updateBinder } = useBinder();
  const [name, setName] = useState(binder.name);
  const [color, setColor] = useState(binder.color || "#dc2626");
  const [texture, setTexture] = useState(binder.texture || "leather");

  const handleSave = () => {
    if (!name.trim()) return;
    updateBinder({ id: binder.id, name: name.trim(), color, texture });
    onClose();
  };

  const binderStyle = getBinderStyle({ color, texture });
  const darkColor = darken(color, 50);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-lg p-6 shadow-2xl mx-4 max-h-screen overflow-y-auto">
        <h2 className="text-xl font-bold text-white mb-6 flex items-center gap-2">
          <Icon.Edit className="w-5 h-5 text-red-500" /> Editar Binder
        </h2>

        <div className="space-y-5">
          {/* Nombre */}
          <div>
            <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Nombre</label>
            <input
              autoFocus
              className="w-full bg-zinc-800 border border-zinc-600 rounded-xl px-4 py-3 text-white placeholder-zinc-500 focus:outline-none focus:border-red-500 transition-colors"
              placeholder="Nombre del binder"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
            />
          </div>

          {/* Color */}
          <div>
            <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 flex items-center gap-1">
              <Icon.Palette className="w-3.5 h-3.5" /> Color de tapa
            </label>
            <div className="flex flex-wrap gap-2 mb-2">
              {COLOR_PRESETS.map(({ color: c, label }) => (
                <button key={c} title={label} onClick={() => setColor(c)}
                  className={`w-7 h-7 rounded-full border-2 transition-all hover:scale-110 ${color === c ? "border-white scale-110" : "border-transparent"}`}
                  style={{ backgroundColor: c }} />
              ))}
              <label className="relative w-7 h-7 rounded-full border-2 border-dashed border-zinc-500 hover:border-white transition-colors cursor-pointer flex items-center justify-center overflow-hidden" title="Color personalizado">
                <span className="text-zinc-400 text-xs">+</span>
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)}
                  className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" />
              </label>
            </div>
          </div>

          {/* Textura */}
          <div>
            <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Textura</label>
            <div className="flex gap-2 flex-wrap">
              {Object.entries(TEXTURES).map(([key, tx]) => (
                <button key={key} onClick={() => setTexture(key)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${texture === key ? "border-red-500 bg-red-500/15 text-red-300" : "border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-500"}`}>
                  {tx.emoji} {tx.label}
                </button>
              ))}
            </div>
          </div>

          {/* Preview */}
          <div className="p-4 bg-zinc-950 rounded-xl border border-zinc-800">
            <p className="text-xs text-zinc-600 mb-3">Vista previa</p>
            <div className="flex items-stretch gap-0 h-28 max-w-xs mx-auto rounded-lg overflow-hidden shadow-2xl"
              style={{ filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.6))" }}>
              <div className="w-7 flex flex-col items-center justify-center gap-1 rounded-l-lg"
                style={{ backgroundColor: darkColor, boxShadow: "inset -2px 0 6px rgba(0,0,0,0.4)" }}>
                {[0,1,2].map(i => (
                  <div key={i} className="w-3 h-3 rounded-full border-2 border-white/20"
                    style={{ backgroundColor: "rgba(255,255,255,0.1)" }} />
                ))}
              </div>
              <div className="flex-1 flex flex-col items-center justify-center rounded-r-lg relative overflow-hidden" style={binderStyle}>
                <div className="absolute inset-0" style={{ backgroundColor: `${color}dd` }} />
                <div className="relative z-10 text-white text-xs font-bold text-center px-2 truncate w-full"
                  style={{ textShadow: "0 1px 4px rgba(0,0,0,0.5)" }}>
                  {name || "Nombre del binder"}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex gap-3 mt-8">
          <button onClick={onClose} className="flex-1 py-3 rounded-xl border border-zinc-600 text-zinc-300 hover:bg-zinc-800 transition-colors font-semibold">Cancelar</button>
          <button onClick={handleSave} disabled={!name.trim()} className="flex-1 py-3 rounded-xl bg-red-600 text-white font-bold hover:bg-red-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            Guardar cambios
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── SIDEBAR ─────────────────────────────────────────────────────────────────
function Sidebar({ onNewBinder, onEditBinder, isOpen, onClose }) {
  const { binders, activeBinder, setActiveBinder, deleteBinder } = useBinder();
  return (
    <>
      {/* Overlay en mobile cuando el sidebar está abierto */}
      {isOpen && (
        <div className="fixed inset-0 bg-black/60 z-20 md:hidden" onClick={onClose} />
      )}
      <aside className={`
        fixed md:relative inset-y-0 left-0 z-30 md:z-auto
        w-64 md:w-56 bg-zinc-950 border-r border-zinc-800 flex flex-col shrink-0
        transition-transform duration-300 ease-in-out
        ${isOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}
      `}>
      <div className="p-3 border-b border-zinc-800">
        <button onClick={onNewBinder}
          className="w-full flex items-center justify-center gap-2 py-2 px-3 bg-red-600 hover:bg-red-500 text-white font-bold rounded-xl transition-colors text-sm">
          <Icon.Plus className="w-4 h-4" /> Nuevo Binder
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {binders.length === 0 && (
          <div className="text-center text-zinc-700 text-xs py-8 px-3">
            <Icon.Book className="w-7 h-7 mx-auto mb-2 opacity-40" />
            <p>Creá tu primer binder</p>
          </div>
        )}
        {binders.map((b) => {
          const cards = b.pages.flat().filter(Boolean).length;
          const total = b.pages.flat().length;
          const isActive = activeBinder?.id === b.id;
          const c = b.color || "#dc2626";
          return (
            <div key={b.id} onClick={() => { setActiveBinder(b); if (onClose) onClose(); }}
              className={`group flex items-center gap-2 rounded-xl px-3 py-2.5 cursor-pointer transition-all ${isActive ? "border" : "hover:bg-zinc-800/60 border border-transparent"}`}
              style={isActive ? { backgroundColor: `${c}18`, borderColor: `${c}40` } : {}}>
              {/* Mini binder icon */}
              <div className="w-4 h-5 rounded-sm flex-shrink-0 relative overflow-hidden"
                style={{ backgroundColor: c, boxShadow: `1px 0 0 ${darken(c, 30)} inset` }}>
                <div className="absolute left-0 top-0 bottom-0 w-1" style={{ backgroundColor: darken(c, 40) }} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold truncate" style={isActive ? { color: lighten(c, 40) } : { color: "#e4e4e7" }}>{b.name}</p>
                <p className="text-xs text-zinc-600">{b.grid?.label} · {cards}/{total}</p>
              </div>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                <button onClick={(e) => { e.stopPropagation(); onEditBinder(b); }}
                  className="text-zinc-600 hover:text-zinc-300 p-0.5 transition-colors">
                  <Icon.Edit className="w-3 h-3" />
                </button>
                <button onClick={(e) => { e.stopPropagation(); if (confirm(`¿Eliminar "${b.name}"?`)) deleteBinder(b.id); }}
                  className="text-zinc-600 hover:text-red-400 p-0.5 transition-colors">
                  <Icon.Trash className="w-3 h-3" />
                </button>
              </div>
            </div>
          );
        })}
      </nav>
      <div className="p-3 border-t border-zinc-800">
        <p className="text-xs text-zinc-700 text-center">{binders.length} binder{binders.length !== 1 ? "s" : ""} locales</p>
      </div>
    </aside>
    </>
  );
}

// ─── EXPORT PDF ───────────────────────────────────────────────────────────────
function exportBinderToPDF(binder) {
  const { pages, grid, name, color = "#dc2626", texture = "leather" } = binder;
  const darkC = darken(color, 50);
  const lightC = lighten(color, 30);

  // Texture CSS string para el PDF
  const textureCSSMap = {
    leather: `
      repeating-linear-gradient(45deg, rgba(0,0,0,0.15) 0px, rgba(0,0,0,0.15) 1px, transparent 1px, transparent 8px),
      repeating-linear-gradient(-45deg, rgba(0,0,0,0.15) 0px, rgba(0,0,0,0.15) 1px, transparent 1px, transparent 8px)`,
    fabric: `
      repeating-linear-gradient(0deg, rgba(0,0,0,0.12) 0px, rgba(0,0,0,0.12) 1px, transparent 1px, transparent 4px),
      repeating-linear-gradient(90deg, rgba(0,0,0,0.12) 0px, rgba(0,0,0,0.12) 1px, transparent 1px, transparent 4px)`,
    carbon: `
      repeating-linear-gradient(45deg, rgba(0,0,0,0.25) 0px, rgba(0,0,0,0.25) 2px, transparent 2px, transparent 6px),
      repeating-linear-gradient(-45deg, rgba(255,255,255,0.04) 0px, rgba(255,255,255,0.04) 2px, transparent 2px, transparent 6px)`,
    smooth: "none",
  };

  const pagesHTML = pages.map((page, pi) => {
    const rings = [0,1,2].map(() =>
      `<div style="width:14px;height:14px;border-radius:50%;background:radial-gradient(circle at 35% 35%, ${lightC}, ${color});border:3px solid ${darkC};box-shadow:inset 0 1px 3px rgba(0,0,0,0.5);position:relative;">
        <div style="position:absolute;inset:3px;border-radius:50%;background:#111;"></div>
      </div>`
    ).join("");

    const cards = page.map((card) =>
      card
        ? `<div style="border-radius:4px;overflow:hidden;border:1px solid rgba(255,255,255,0.1);box-shadow:0 2px 6px rgba(0,0,0,0.5);">
            <img src="${card.images?.small}" alt="${card.name}" style="width:100%;display:block;aspect-ratio:2.5/3.5;object-fit:cover;"/>
            <div style="background:#0e0e10;padding:2px 3px;text-align:center;">
              <div style="font-size:6px;color:#ccc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${card.name}</div>
            </div>
          </div>`
        : `<div style="aspect-ratio:2.5/3.5;border:1px dashed rgba(255,255,255,0.1);border-radius:4px;background:rgba(255,255,255,0.02);"></div>`
    ).join("");

    return `
    <div class="bpage">
      <div style="display:flex;border-radius:8px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,0.8);min-height:300px;">
        <!-- LOMO -->
        <div style="width:32px;flex-shrink:0;background:linear-gradient(to right, ${darkC}, ${color} 40%, ${lightC} 60%, ${color});display:flex;flex-direction:column;align-items:center;justify-content:space-around;padding:16px 0;background-image:${textureCSSMap[texture]};background-size:8px 8px;">
          ${rings}
        </div>
        <!-- TAPA IZQ -->
        <div style="width:8px;flex-shrink:0;background:linear-gradient(to right,${color},${lightC});"></div>
        <!-- PÁGINA -->
        <div style="flex:1;background:linear-gradient(135deg,#1c1c1f,#18181b);padding:12px;padding-top:20px;position:relative;">
          <div style="position:absolute;top:6px;right:8px;font-size:8px;color:${lightC};background:${color}33;border:1px solid ${color}44;border-radius:999px;padding:1px 7px;font-weight:bold;">${pi + 1}/${pages.length}</div>
          <div style="display:grid;grid-template-columns:repeat(${grid.cols},1fr);gap:6px;">${cards}</div>
        </div>
        <!-- TAPA DER -->
        <div style="width:8px;flex-shrink:0;background:linear-gradient(to right,${lightC},${color});border-radius:0 6px 6px 0;"></div>
      </div>
    </div>`;
  }).join("");

  const win = window.open("", "_blank");
  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"/>
  <title>VirtualBinder — ${name}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0f0f11;color:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    h1{text-align:center;font-size:20px;margin:18px 0 4px;color:${color};}
    .subtitle{text-align:center;font-size:11px;color:#555;margin-bottom:18px;}
    .bpage{page-break-after:always;padding:16px 20px;}
    @media print{
      *{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;}
      body{background:#0f0f11!important;}
      .bpage{page-break-after:always;}
    }
  </style>
  </head>
  <body>
    <h1>📒 ${name}</h1>
    <p class="subtitle">${grid.label} · ${pages.length} páginas · VirtualBinder</p>
    ${pagesHTML}
  </body></html>`);
  win.document.close();
  setTimeout(() => { win.focus(); win.print(); }, 900);
}

// ─── EMPTY STATE ─────────────────────────────────────────────────────────────
function EmptyState({ onNew }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-5 text-center p-8">
      <div className="w-20 h-20 rounded-full bg-red-500/10 border-2 border-red-500/20 flex items-center justify-center">
        <Icon.Pokeball className="w-10 h-10 text-red-500" />
      </div>
      <div>
        <h2 className="text-xl font-bold text-white mb-2">Bienvenido a VirtualBinder</h2>
        <p className="text-zinc-500 max-w-sm text-sm">Creá tu primer binder virtual y organizá tu colección de Pokémon TCG.</p>
      </div>
      <button onClick={onNew} className="flex items-center gap-2 px-5 py-2.5 bg-red-600 hover:bg-red-500 text-white font-bold rounded-xl transition-colors text-sm">
        <Icon.Plus className="w-4 h-4" /> Crear mi primer Binder
      </button>
    </div>
  );
}

// ─── ROOT ────────────────────────────────────────────────────────────────────
function AppContent() {
  const { activeBinder } = useBinder();
  const [showCreate, setShowCreate] = useState(false);
  const [editBinder, setEditBinder] = useState(null);
  const [targetSlot, setTargetSlot] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const handleAddCard = useCallback((pi, si) => setTargetSlot({ pageIndex: pi, slotIndex: si }), []);

  // Update document title & favicon
  useEffect(() => {
    document.title = "VirtualBinder — Pokémon TCG";
    // Set favicon as SVG pokeball
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="48" fill="%23dc2626" stroke="%23991b1b" stroke-width="4"/>
      <path d="M2 50 Q2 2 50 2 Q98 2 98 50" fill="%23dc2626"/>
      <path d="M2 50 Q2 98 50 98 Q98 98 98 50" fill="white"/>
      <rect x="2" y="44" width="96" height="12" fill="%23111"/>
      <circle cx="50" cy="50" r="14" fill="white" stroke="%23111" stroke-width="4"/>
      <circle cx="50" cy="50" r="7" fill="%23dc2626"/>
    </svg>`;
    const link = document.querySelector("link[rel~='icon']") || document.createElement("link");
    link.type = "image/svg+xml";
    link.rel = "icon";
    link.href = `data:image/svg+xml,${svg}`;
    document.head.appendChild(link);
  }, []);

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-white">
      <header className="flex items-center gap-3 px-4 py-2.5 bg-zinc-950 border-b border-zinc-800 shrink-0">
        {/* Hamburger - solo mobile */}
        <button onClick={() => setSidebarOpen(o => !o)}
          className="md:hidden p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors shrink-0">
          <Icon.Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2">
          <Icon.Pokeball className="w-7 h-7 text-red-500" />
          <span className="font-black text-base tracking-tight">Virtual<span className="text-red-500">Binder</span></span>
        </div>
        {activeBinder && (
          <>
            <span className="text-zinc-700 text-sm">/</span>
            <div className="flex items-center gap-2">
              {/* Mini color dot */}
              <div className="w-3 h-3 rounded-full border border-white/20"
                style={{ backgroundColor: activeBinder.color || "#dc2626" }} />
              <span className="text-zinc-300 font-semibold text-sm">{activeBinder.name}</span>
            </div>
            <span className="text-xs bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded-full">{activeBinder.grid?.label}</span>
          </>
        )}
      </header>

      <div className="flex flex-1 overflow-hidden">
        <Sidebar onNewBinder={() => { setShowCreate(true); setSidebarOpen(false); }} onEditBinder={(b) => { setEditBinder(b); setSidebarOpen(false); }} isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <main className="flex-1 flex flex-col overflow-hidden">
          {activeBinder ? (
            <>
              <BinderStatsBar onExport={() => exportBinderToPDF(activeBinder)} />
              <div className="flex-1 overflow-y-auto p-5">
                <BinderPageView onAddCard={handleAddCard} />
              </div>
            </>
          ) : (
            <EmptyState onNew={() => setShowCreate(true)} />
          )}
        </main>
      </div>

      {showCreate && <CreateBinderModal onClose={() => setShowCreate(false)} />}
      {editBinder && <EditBinderModal binder={editBinder} onClose={() => setEditBinder(null)} />}
      {targetSlot && <CardSearchPanel targetSlot={targetSlot} onClose={() => setTargetSlot(null)} />}
    </div>
  );
}

export default function App() {
  return <BinderProvider><AppContent /></BinderProvider>;
}