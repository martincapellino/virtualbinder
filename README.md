# 📒 VirtualBinder — Pokémon TCG

Aplicación web para crear binders virtuales de cartas de Pokémon TCG. Organizá tu colección como si fuera una carpeta física.

---

## 🚀 Cómo correrlo

### 1. Requisitos previos
- Node.js 18+ (recomendado: 20 LTS)
- npm o yarn

### 2. Instalar dependencias
```bash
cd virtual-binder
npm install
```

### 3. Correr en modo desarrollo
```bash
npm run dev
```

Abrí http://localhost:5173 en tu navegador.

### 4. Build para producción
```bash
npm run build
npm run preview
```

---

## 📁 Estructura del proyecto

```
virtual-binder/
├── index.html              # Entry HTML
├── vite.config.js          # Vite bundler config
├── tailwind.config.js      # Tailwind config
├── postcss.config.js       # PostCSS config
├── package.json
└── src/
    ├── main.jsx            # React entry point
    ├── index.css           # Tailwind base + custom scrollbar
    └── App.jsx             # Toda la app (contexto + componentes)
```

El MVP está en un solo archivo `App.jsx` por simplicidad. Para V2 se separaría en:
```
src/
  components/
    BinderPageView.jsx
    CardSearchPanel.jsx
    CardSlot.jsx
    CreateBinderModal.jsx
    Sidebar.jsx
    BinderStatsBar.jsx
  context/
    BinderContext.jsx
  hooks/
    useBinderExport.js
  utils/
    api.js
    prices.js
```

---

## 🧩 Funcionalidades del MVP

- ✅ Crear binders con nombre, páginas y grilla configurable (2×2, 3×3, 4×3)
- ✅ Buscar cartas via Pokémon TCG API (pokemontcg.io)
- ✅ Agregar cartas a slots con click
- ✅ Quitar cartas con hover + botón
- ✅ Navegar entre páginas del binder
- ✅ Ver precio estimado por carta (cardmarket/tcgplayer)
- ✅ Calcular valor total del binder
- ✅ Barra de progreso de llenado
- ✅ Exportar a PDF via ventana de impresión
- ✅ Persistencia en localStorage

---

## 🔑 Decisiones técnicas

| Decisión | Razón |
|---|---|
| Todo en App.jsx | Evitar complejidad innecesaria en MVP |
| Context API + useState | Suficiente para este scope, sin Redux |
| pokemontcg.io API | Pública, sin API key requerida |
| localStorage | Persistencia sin backend real |
| Export via window.print() | Sin deps extra (jsPDF, html2canvas) |
| Inline SVG icons | Sin lucide-react ni iconfonts |
| Vite | Build tool moderno, dev rápido |

---

## 🗺️ Roadmap V2

- [ ] Drag & drop entre slots y entre páginas
- [ ] Múltiples vistas (lista, cuadrícula compacta)
- [ ] Filtros en búsqueda (por set, rarity, tipo)
- [ ] Importar desde archivos CSV/PTCGO
- [ ] Compartir binder via URL (usando parámetros o servicio)
- [ ] Historial de precios con gráfico
- [ ] Animación flip de página tipo libro real
- [ ] Soporte auth + backend (Supabase/Firebase)
- [ ] Export PDF mejorado con html2canvas
- [ ] Modo "lista de wishlist" para cartas faltantes

---

## 🌐 API utilizada

**Pokémon TCG API** — https://pokemontcg.io/

- No requiere API key para uso básico (rate limit: 1000 req/día)
- Endpoint usado: `GET /v2/cards?q=name:"X*"&select=id,name,images,set,cardmarket,tcgplayer,rarity`
- Precios: `card.cardmarket.prices.averageSellPrice` o `card.tcgplayer.prices.*.market`
