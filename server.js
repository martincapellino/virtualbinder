// server.js — Proxy local para Pokémon TCG API
// Evita el bloqueo CORS al hacer el fetch desde Node (server-side)
import express from "express";
import cors from "cors";

const app = express();
const PORT = 3001;
const API_BASE = "https://api.pokemontcg.io/v2";

app.use(cors());
app.use(express.json());

// Proxy genérico: /api/v2/* → https://api.pokemontcg.io/v2/*
app.get("/api/v2/:resource", async (req, res) => {
  try {
    const url = new URL(`${API_BASE}/${req.params.resource}`);
    // Pasar todos los query params tal cual
    Object.entries(req.query).forEach(([k, v]) => url.searchParams.set(k, v));

    const response = await fetch(url.toString(), {
      headers: {
        "Content-Type": "application/json",
        // Si tenés API key, ponela aquí:
        // "X-Api-Key": "tu-api-key",
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `API error: ${response.status}` });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Proxy error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Proxy corriendo en http://localhost:${PORT}`);
  console.log(`   Redirigiendo a ${API_BASE}`);
});
