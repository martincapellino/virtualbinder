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
    try { return JSON.parse(localStorage.getItem("vb_binders") || "[]"); } catch { return []; }
  });
  const [activeBinder, setActiveBinder] = useState(null);
  const [currentPage, setCurrentPage] = useState(0);

  const save = useCallback((next) => {
    setBinders(next);
    localStorage.setItem("vb_binders", JSON.stringify(next));
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

  const addCardToSlot = useCallback((pageIndex, slotIndex, card) => {
    if (!activeBinder) return;
    const updated = activeBinder.pages.map((page, pi) =>
      pi === pageIndex ? page.map((slot, si) => (si === slotIndex ? card : slot)) : page
    );
    const ub = { ...activeBinder, pages: updated };
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
      createBinder, deleteBinder, addCardToSlot, removeCardFromSlot, getTotalCost,
    }}>
      {children}
    </BinderContext.Provider>
  );
}

// ─── API ────────────────────────────────────────────────────────────────────
const API_BASE = "/api/v2";

function buildQuery(name, filters) {
  const parts = [];
  if (name?.trim()) parts.push(`name:"${name.trim()}*"`);
  if (filters.rarity)    parts.push(`rarity:"${filters.rarity}"`);
  if (filters.set)       parts.push(`set.id:"${filters.set}"`);
  if (filters.type)      parts.push(`types:${filters.type}`);
  if (filters.subtype)   parts.push(`subtypes:"${filters.subtype}"`);
  if (filters.supertype) parts.push(`supertype:${filters.supertype}`);
  if (filters.legality)  parts.push(`legalities.${filters.legality}:legal`);
  return parts.join(" ");
}

function buildFallbackQueries(name, filters) {
  const raw = name?.trim() || "";
  const queries = [];
  const q1 = buildQuery(raw, filters);
  if (q1) queries.push(q1);
  if (raw.includes(" ")) {
    const tokens = raw.split(/\s+/);
    const firstName = tokens[0];
    const rest = tokens.slice(1).join(" ");
    const q2 = buildQuery(firstName, filters);
    if (q2 && !queries.includes(q2)) queries.push(q2);
    const parts3 = [`name:"${firstName}*"`, `set.name:"*${rest}*"`];
    if (filters.rarity) parts3.push(`rarity:"${filters.rarity}"`);
    if (filters.type)   parts3.push(`types:${filters.type}`);
    const q3 = parts3.join(" ");
    if (!queries.includes(q3)) queries.push(q3);
    const parts4 = [`name:"${firstName}*"`, `set.series:"*${rest}*"`];
    const q4 = parts4.join(" ");
    if (!queries.includes(q4)) queries.push(q4);
  }
  return queries;
}

async function rawFetch(q, page, pageSize) {
  const params = new URLSearchParams({
    q, page, pageSize,
    select: "id,name,images,set,cardmarket,tcgplayer,rarity,types,subtypes,supertype,number",
    orderBy: "set.releaseDate,-number",
  });
  const res = await fetch(`${API_BASE}/cards?${params}`);
  if (!res.ok) throw new Error("Error al buscar cartas (status " + res.status + ")");
  return res.json();
}

async function searchCards(name, filters = {}, page = 1, pageSize = 36) {
  const queries = buildFallbackQueries(name, filters);
  if (!queries.length) return { data: [], totalCount: 0, page, pageSize };
  let lastData = { data: [], totalCount: 0, page, pageSize };
  for (const q of queries) {
    const data = await rawFetch(q, page, pageSize);
    if ((data.data || []).length > 0) return data;
    lastData = data;
  }
  return lastData;
}

async function autocomplete(query) {
  if (!query || query.length < 2) return [];
  const firstName = query.trim().split(/\s+/)[0];
  const params = new URLSearchParams({
    q: `name:"${firstName}*"`, pageSize: 8,
    select: "id,name,set,images", orderBy: "name",
  });
  const res = await fetch(`${API_BASE}/cards?${params}`);
  if (!res.ok) return [];
  const data = await res.json();
  const seen = new Set();
  return (data.data || []).filter((c) => {
    if (seen.has(c.name)) return false;
    seen.add(c.name); return true;
  });
}

async function fetchSets() {
  const res = await fetch(`${API_BASE}/sets?orderBy=-releaseDate&pageSize=250&select=id,name,series`);
  if (!res.ok) return [];
  return (await res.json()).data || [];
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
function AutocompleteInput({ value, onChange, onSearch, placeholder }) {
  const [suggestions, setSuggestions] = useState([]);
  const [showSug, setShowSug] = useState(false);
  const [loadingSug, setLoadingSug] = useState(false);
  const debounceRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (!containerRef.current?.contains(e.target)) setShowSug(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleChange = (e) => {
    const v = e.target.value;
    onChange(v);
    clearTimeout(debounceRef.current);
    if (v.length < 2) { setSuggestions([]); setShowSug(false); return; }
    debounceRef.current = setTimeout(async () => {
      setLoadingSug(true);
      const results = await autocomplete(v);
      setSuggestions(results);
      setShowSug(results.length > 0);
      setLoadingSug(false);
    }, 280);
  };

  const handleSelect = (card) => {
    onChange(card.name);
    setSuggestions([]); setShowSug(false);
    onSearch(card.name);
  };

  return (
    <div ref={containerRef} className="relative flex-1">
      <input
        className="w-full bg-zinc-800 border border-zinc-600 rounded-xl px-4 py-2.5 text-white placeholder-zinc-500 focus:outline-none focus:border-red-500 transition-colors"
        placeholder={placeholder}
        value={value}
        onChange={handleChange}
        onFocus={() => suggestions.length > 0 && setShowSug(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { setShowSug(false); onSearch(value); }
          if (e.key === "Escape") setShowSug(false);
        }}
      />
      {loadingSug && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          <div className="w-4 h-4 border-2 border-red-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      {showSug && suggestions.length > 0 && (
        <div className="absolute top-full mt-1 left-0 right-0 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl z-50 overflow-hidden">
          {suggestions.map((card) => (
            <button key={card.id} onMouseDown={() => handleSelect(card)}
              className="w-full flex items-center gap-3 px-3 py-2 hover:bg-zinc-800 transition-colors text-left">
              {card.images?.small && (
                <img src={card.images.small} alt={card.name} className="w-8 h-11 object-cover rounded flex-shrink-0" />
              )}
              <div className="min-w-0">
                <p className="text-white text-sm font-medium truncate">{card.name}</p>
                <p className="text-zinc-500 text-xs truncate">{card.set?.name}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── FILTER PANEL ───────────────────────────────────────────────────────────
const TYPES = ["Colorless","Darkness","Dragon","Fairy","Fighting","Fire","Grass","Lightning","Metal","Psychic","Water"];
const SUPERTYPES = ["Pokémon","Trainer","Energy"];
const SUBTYPES = ["Basic","Stage 1","Stage 2","GX","EX","V","VMAX","VSTAR","ex","Mega","Prism Star","TAG TEAM","Item","Supporter","Stadium","Special","Basic Energy","Special Energy"];
const LEGALITIES = [{value:"standard",label:"Standard"},{value:"expanded",label:"Expanded"},{value:"unlimited",label:"Unlimited"}];

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
        <div className="absolute top-full mt-2 right-0 bg-zinc-900 border border-zinc-700 rounded-xl p-4 z-50 shadow-2xl w-[520px] grid grid-cols-3 gap-3">
          <Sel label="Rareza" field="rarity" options={rarities.map((r) => ({ value: r, label: r }))} />
          <Sel label="Set / Expansión" field="set" options={sets.map((s) => ({ value: s.id, label: s.name }))} />
          <Sel label="Tipo de energía" field="type" options={TYPES} />
          <Sel label="Supertipo" field="supertype" options={SUPERTYPES} />
          <Sel label="Subtipo" field="subtype" options={SUBTYPES} />
          <Sel label="Legalidad" field="legality" options={LEGALITIES} />
          <div className="col-span-3 flex justify-between items-center pt-1 border-t border-zinc-800">
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
let _searchState = { query: "", filters: {}, results: [], totalCount: 0, page: 1, searched: false };

function CardSearchPanel({ targetSlot, onClose }) {
  const { addCardToSlot } = useBinder();
  const [query, setQuery] = useState(_searchState.query);
  const [results, setResults] = useState(_searchState.results);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searched, setSearched] = useState(_searchState.searched);
  const [page, setPage] = useState(_searchState.page);
  const [totalCount, setTotalCount] = useState(_searchState.totalCount);
  const [filters, setFilters] = useState(_searchState.filters);
  const [sets, setSets] = useState([]);
  const [rarities, setRarities] = useState([]);

  const activeFilterCount = useMemo(() => Object.values(filters).filter(Boolean).length, [filters]);

  useEffect(() => {
    fetchSets().then(setSets);
    fetchRarities().then(setRarities);
  }, []);

  useEffect(() => {
    return () => { _searchState = { query, filters, results, totalCount, page, searched }; };
  }, [query, filters, results, totalCount, page, searched]);

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

  const handleSearch = (q = query) => { setPage(1); doSearch(q, filters, 1); };
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
          <AutocompleteInput value={query} onChange={setQuery} onSearch={handleSearch} placeholder="Ej: Gengar, Charizard 151, Pikachu..." />
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

// ─── CARD SLOT ───────────────────────────────────────────────────────────────
function CardSlot({ card, pageIndex, slotIndex, onAdd }) {
  const { removeCardFromSlot } = useBinder();
  const [hovered, setHovered] = useState(false);

  if (card) {
    const price = getCardPrice(card);
    const pcUrl = getPriceChartingUrl(card);
    return (
      <div className="relative rounded overflow-hidden border border-zinc-600/40 hover:border-red-500/60 transition-all cursor-default shadow-sm"
        style={{ aspectRatio: "2.5/3.5", width: "100%" }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}>
        <img src={card.images?.small} alt={card.name} className="w-full h-full object-cover" draggable={false} />
        <div className={`absolute inset-0 bg-black/78 flex flex-col items-center justify-center gap-1 transition-opacity p-1 ${hovered ? "opacity-100" : "opacity-0"}`}>
          <p className="text-white text-[10px] font-semibold text-center leading-tight">{card.name}</p>
          <p className="text-zinc-400 text-[8px] text-center leading-tight">{card.set?.name}</p>
          {price ? (
            <a href={pcUrl} target="_blank" rel="noopener noreferrer"
              className="text-red-400 text-[9px] font-bold hover:text-red-300 hover:underline flex items-center gap-0.5 mt-0.5">
              ${price.toFixed(2)} <Icon.ExternalLink className="w-2.5 h-2.5" />
            </a>
          ) : (
            <a href={pcUrl} target="_blank" rel="noopener noreferrer"
              className="text-zinc-500 text-[8px] hover:text-zinc-300 flex items-center gap-0.5 mt-0.5">
              Ver precio <Icon.ExternalLink className="w-2 h-2" />
            </a>
          )}
          <button onClick={() => removeCardFromSlot(pageIndex, slotIndex)}
            className="mt-1 p-1 bg-red-600 hover:bg-red-500 text-white rounded transition-colors">
            <Icon.X className="w-3 h-3" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <button onClick={() => onAdd(pageIndex, slotIndex)}
      style={{ aspectRatio: "2.5/3.5", width: "100%" }}
      className="rounded border border-dashed border-zinc-600/30 hover:border-red-500/50 hover:bg-red-500/5 transition-all flex items-center justify-center group">
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
  const { activeBinder, currentPage, setCurrentPage } = useBinder();
  const [zoom, setZoom] = useState(0.85);

  if (!activeBinder) return null;
  const { pages, grid, color = "#dc2626", texture = "leather" } = activeBinder;
  const page = pages[currentPage];
  const binderStyle = getBinderStyle(activeBinder);
  const darkC = darken(color, 50);
  const lightC = lighten(color, 20);

  return (
    <div className="flex flex-col gap-3">
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
      <div className="flex justify-start">
        <div style={{ width: `${zoom * 100}%` }}>
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
              <div className="absolute inset-0 opacity-[0.03]"
                style={{
                  backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 27px, rgba(255,255,255,0.5) 27px, rgba(255,255,255,0.5) 28px)",
                  backgroundSize: "100% 28px",
                }} />

              {/* Page number tab */}
              <div className="absolute top-3 right-3 text-[9px] font-bold px-2 py-0.5 rounded-full"
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

// ─── SIDEBAR ─────────────────────────────────────────────────────────────────
function Sidebar({ onNewBinder }) {
  const { binders, activeBinder, setActiveBinder, deleteBinder } = useBinder();
  return (
    <aside className="w-56 bg-zinc-950 border-r border-zinc-800 flex flex-col shrink-0">
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
            <div key={b.id} onClick={() => setActiveBinder(b)}
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
              <button onClick={(e) => { e.stopPropagation(); if (confirm(`¿Eliminar "${b.name}"?`)) deleteBinder(b.id); }}
                className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 transition-all p-0.5 shrink-0">
                <Icon.Trash className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </nav>
      <div className="p-3 border-t border-zinc-800">
        <p className="text-xs text-zinc-700 text-center">{binders.length} binder{binders.length !== 1 ? "s" : ""} locales</p>
      </div>
    </aside>
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
  const [targetSlot, setTargetSlot] = useState(null);
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
      <header className="flex items-center gap-3 px-5 py-2.5 bg-zinc-950 border-b border-zinc-800 shrink-0">
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
        <Sidebar onNewBinder={() => setShowCreate(true)} />
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
      {targetSlot && <CardSearchPanel targetSlot={targetSlot} onClose={() => setTargetSlot(null)} />}
    </div>
  );
}

export default function App() {
  return <BinderProvider><AppContent /></BinderProvider>;
}
