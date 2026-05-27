/**
 * DRAG·AI — ACTES BACKEND v1.0
 * ================================
 * Registre d'actes administratives de la Guàrdia Municipal de Figaró-Montmany
 *
 * PORT: 10002
 * DB:   /srv/police/actes-backend/actes.db
 * AUTH: token compartit amb central/bitacola (users.db symlink)
 *
 * ENDPOINTS:
 *   POST /api/actes/login          → valida token (delega a users.db)
 *   GET  /api/actes                → llista actes (amb filtres)
 *   GET  /api/actes/:id            → detall d'una acta
 *   POST /api/actes                → crear nova acta (immutable un cop creada)
 *   GET  /api/actes/num-seguent    → propera numeració AAAA-NNNN
 *   POST /api/actes/persona/cerca  → cerca persona a hermano_mayor.db via Sherlock
 *   POST /api/actes/persona/alta   → alta nova persona a hermano_mayor.db
 *   GET  /health
 */

import express  from "express";
import cors     from "cors";
import Database from "better-sqlite3";
import fetch    from "node-fetch";
import path     from "path";
import { existsSync } from "fs";
import fs from "fs";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";

const app  = express();
const PORT = process.env.PORT || 10002;

const ACTES_DB_PATH    = process.env.ACTES_DB_PATH    || "/srv/police/actes-backend/actes.db";
const USERS_DB_PATH    = process.env.USERS_DB_PATH    || "/srv/police/central-backend/users.db";
const SHERLOCK_URL     = process.env.SHERLOCK_URL      || "http://localhost:8000";
const HERMANO_DB_PATH  = process.env.HERMANO_DB_PATH  || "/srv/police/sherlock-backend/hermano_mayor.db";

app.use(express.json({ limit: "10mb" }));
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","Authorization"] }));

// ============================================================================
// INICIALITZACIÓ BD
// ============================================================================

let db;
try {
  db = new Database(ACTES_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
} catch(e) {
  // Dev mode: BD local
  console.warn("⚠ actes.db no trobat a ruta producció, usant BD local de dev");
  db = new Database("./actes_dev.db");
  db.pragma("journal_mode = WAL");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS actes (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    num_registre      TEXT NOT NULL UNIQUE,
    codi_acta         TEXT NOT NULL DEFAULT 'A-10',
    titol_acta        TEXT NOT NULL DEFAULT 'Acta genèrica',

    -- Metadades
    data_acta         TEXT NOT NULL,
    hora_inici        TEXT NOT NULL,
    hora_fi           TEXT,
    tip_instructor    TEXT NOT NULL,
    tip_secretari     TEXT,
    destinacio        TEXT DEFAULT 'GM Figaró',

    -- Lloc
    lloc_adreca       TEXT,
    lloc_municipi     TEXT DEFAULT 'Figaró-Montmany',
    lloc_comarca      TEXT DEFAULT 'Vallès Oriental',
    lloc_tipus        TEXT,
    lloc_nom_extra    TEXT,

    -- Persona (nullable — actes sense persona identificada)
    persona_cognom1   TEXT,
    persona_cognom2   TEXT,
    persona_nom       TEXT,
    persona_doc_tipus TEXT,
    persona_doc_num   TEXT,
    persona_naix_data TEXT,
    persona_naix_loc  TEXT,
    persona_naix_comarca TEXT,
    persona_naix_pais TEXT DEFAULT 'Espanya',
    persona_nom_pare  TEXT,
    persona_nom_mare  TEXT,
    persona_adreca    TEXT,
    persona_municipi  TEXT,
    persona_comarca   TEXT,
    persona_tel       TEXT,
    persona_adreca_t  TEXT,
    persona_municipi_t TEXT,
    persona_tel_t     TEXT,
    persona_fi_t      TEXT,
    persona_menor     INTEGER DEFAULT 0,
    persona_hm_id     INTEGER,

    -- Vehicle (nullable)
    vehicle_matricula TEXT,
    vehicle_marca     TEXT,
    vehicle_model     TEXT,
    vehicle_asseguradora TEXT,
    conductor_nom     TEXT,
    conductor_dni     TEXT,

    -- Infracció / article
    article_infringit TEXT,

    -- Contingut
    text_fets         TEXT NOT NULL,
    observacions      TEXT,

    -- Camps específics de cada codi en JSON
    camps_extra       TEXT DEFAULT '{}',

    -- Audit
    created_by        TEXT NOT NULL,
    created_at        TEXT DEFAULT (datetime('now','localtime')),

    -- Les actes NO es poden modificar ni eliminar
    -- No hi ha columna updated_at per disseny
    CHECK (codi_acta IN (
      'A-10','A-17','A-205','A-206','AA-31',
      'D-OM-1','D-OM-2',
      'D-10','D-10bis','D-10ter',
      'A-09','A-13','A-13b','A-14','A-14b','A-25','A-28','A-50',
      'AP-01','AP-04','D-20','A-46'
    ))
  );

  CREATE TABLE IF NOT EXISTS actes_audit (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    acta_id   INTEGER NOT NULL,
    accio     TEXT NOT NULL,
    agent     TEXT NOT NULL,
    detall    TEXT,
    ts        TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (acta_id) REFERENCES actes(id)
  );

  CREATE INDEX IF NOT EXISTS idx_actes_num     ON actes(num_registre);
  CREATE INDEX IF NOT EXISTS idx_actes_data    ON actes(data_acta);
  CREATE INDEX IF NOT EXISTS idx_actes_codi    ON actes(codi_acta);
  CREATE INDEX IF NOT EXISTS idx_actes_persona ON actes(persona_doc_num);
`);

console.log("✓ actes.db inicialitzada");

// ============================================================================
// AUTH HELPERS
// ============================================================================

let usersDb = null;
function getUsersDb() {
  if (usersDb) return usersDb;
  if (existsSync(USERS_DB_PATH)) {
    usersDb = new Database(USERS_DB_PATH, { readonly: true });
    console.log("✓ users.db connectada");
  }
  return usersDb;
}

// Caché de sessions validades (evita crida HTTP a cada request)
const sessionCache = new Map();
const SESSION_CACHE_TTL = 60_000; // 1 minut

async function validateTokenAsync(token) {
  if (!token) return null;
  if (token === "dev-token") return { username: "dev", displayName: "Dev Agent", role: "agent" };

  // Comprova caché
  const cached = sessionCache.get(token);
  if (cached && Date.now() - cached.ts < SESSION_CACHE_TTL) return cached.user;

  // Valida contra Bitàcola (port 10000) — és el sistema d'auth principal
  try {
    const r = await fetch("http://127.0.0.1:10000/api/check-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(3000)
    });
    const d = await r.json();
    if (d.ok) {
      const user = {
        username: d.username,
        displayName: d.displayName || d.username,
        role: d.role || "agent"
      };
      sessionCache.set(token, { user, ts: Date.now() });
      return user;
    }
  } catch(e) {
    console.warn("Bitàcola auth error:", e.message);
  }
  return null;
}

function requireAuth(req, res, next) {
  const header = req.headers["authorization"] || "";
  const token  = header.replace("Bearer ", "").trim();
  validateTokenAsync(token).then(user => {
    if (!user) return res.status(401).json({ ok: false, error: "No autoritzat" });
    req.user = user;
    next();
  }).catch(() => res.status(401).json({ ok: false, error: "Error d'autenticació" }));
}

// ============================================================================
// NUMERACIÓ
// ============================================================================

function nextNumRegistre() {
  const year = new Date().getFullYear().toString();
  const row = db.prepare(`
    SELECT MAX(CAST(SUBSTR(num_registre, 6) AS INTEGER)) as mx FROM actes
    WHERE num_registre LIKE ?
  `).get(`${year}-%`);
  const n = ((row.mx || 0) + 1).toString().padStart(4, "0");
  return `${year}-${n}`;
}

// ============================================================================
// ENDPOINTS
// ============================================================================

// Validació simple de token (per confirmar acta sense password)
app.post("/api/actes/auth/confirm", requireAuth, (req, res) => {
  res.json({ ok: true, user: req.user });
});

// Health
app.get("/health", (req, res) => {
  const cnt = db.prepare("SELECT COUNT(*) as n FROM actes").get();
  res.json({ status: "ok", actes: cnt.n, ts: new Date().toISOString() });
});

// Propera numeració (sense crear)
app.get("/api/actes/num-seguent", requireAuth, (req, res) => {
  res.json({ ok: true, num_registre: nextNumRegistre() });
});

// Llista actes amb filtres
app.get("/api/actes", requireAuth, (req, res) => {
  const { codi, data_from, data_to, persona_doc, q, limit = 50, offset = 0 } = req.query;

  let where = [];
  let params = [];

  if (codi)        { where.push("codi_acta = ?");          params.push(codi); }
  if (data_from)   { where.push("data_acta >= ?");          params.push(data_from); }
  if (data_to)     { where.push("data_acta <= ?");          params.push(data_to); }
  if (persona_doc) { where.push("persona_doc_num LIKE ?");  params.push(`%${persona_doc}%`); }
  if (q) {
    where.push(`(
      num_registre LIKE ? OR text_fets LIKE ? OR
      persona_cognom1 LIKE ? OR persona_nom LIKE ? OR
      lloc_adreca LIKE ?
    )`);
    const s = `%${q}%`;
    params.push(s, s, s, s, s);
  }

  const whereStr = where.length ? "WHERE " + where.join(" AND ") : "";

  const actes = db.prepare(`
    SELECT id, num_registre, codi_acta, titol_acta,
           data_acta, hora_inici, tip_instructor,
           persona_cognom1, persona_cognom2, persona_nom, persona_doc_num,
           lloc_adreca, lloc_municipi, lloc_tipus,
           created_by, created_at
    FROM actes
    ${whereStr}
    ORDER BY data_acta DESC, hora_inici DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), parseInt(offset));

  const total = db.prepare(`SELECT COUNT(*) as n FROM actes ${whereStr}`).get(...params);

  res.json({ ok: true, actes, total: total.n });
});

// Detall d'una acta
app.get("/api/actes/:id", requireAuth, (req, res) => {
  const acta = db.prepare("SELECT * FROM actes WHERE id = ? OR num_registre = ?")
                 .get(req.params.id, req.params.id);
  if (!acta) return res.status(404).json({ ok: false, error: "Acta no trobada" });

  // Audit trail
  const audit = db.prepare(`
    SELECT accio, agent, detall, ts FROM actes_audit
    WHERE acta_id = ? ORDER BY ts ASC
  `).all(acta.id);

  // Log consulta
  db.prepare(`INSERT INTO actes_audit (acta_id, accio, agent, detall) VALUES (?,?,?,?)`)
    .run(acta.id, "CONSULTAR", req.user.username, null);

  if (acta.camps_extra) {
    try { acta.camps_extra = JSON.parse(acta.camps_extra); } catch(e) { acta.camps_extra = {}; }
  }

  res.json({ ok: true, acta, audit });
});

// Crear acta (immutable)
app.post("/api/actes", requireAuth, (req, res) => {
  const d = req.body;

  // Validació mínima
  if (!d.data_acta)      return res.status(400).json({ ok: false, error: "data_acta és obligatòria" });
  if (!d.hora_inici)     return res.status(400).json({ ok: false, error: "hora_inici és obligatòria" });
  if (!d.tip_instructor) return res.status(400).json({ ok: false, error: "tip_instructor és obligatori" });
  if (!d.text_fets || !d.text_fets.trim())
                         return res.status(400).json({ ok: false, error: "text_fets és obligatori" });

  const num = nextNumRegistre();

  try {
    const stmt = db.prepare(`
      INSERT INTO actes (
        num_registre, codi_acta, titol_acta,
        data_acta, hora_inici, hora_fi,
        tip_instructor, tip_secretari, destinacio,
        lloc_adreca, lloc_municipi, lloc_comarca, lloc_tipus, lloc_nom_extra,
        persona_cognom1, persona_cognom2, persona_nom,
        persona_doc_tipus, persona_doc_num,
        persona_naix_data, persona_naix_loc, persona_naix_comarca, persona_naix_pais,
        persona_nom_pare, persona_nom_mare,
        persona_adreca, persona_municipi, persona_comarca, persona_tel,
        persona_adreca_t, persona_municipi_t, persona_tel_t, persona_fi_t,
        persona_menor, persona_hm_id,
        vehicle_matricula, vehicle_marca, vehicle_model, vehicle_asseguradora,
        conductor_nom, conductor_dni,
        article_infringit,
        text_fets, observacions, camps_extra,
        created_by
      ) VALUES (
        ?,?,?,
        ?,?,?,
        ?,?,?,
        ?,?,?,?,?,
        ?,?,?,
        ?,?,
        ?,?,?,?,
        ?,?,
        ?,?,?,?,
        ?,?,?,?,
        ?,?,
        ?,?,?,?,
        ?,?,
        ?,
        ?,?,?,
        ?
      )
    `);

    const result = stmt.run(
      num,
      d.codi_acta   || "A-10",
      d.titol_acta  || "Acta genèrica",

      d.data_acta, d.hora_inici, d.hora_fi || null,
      d.tip_instructor, d.tip_secretari || null, d.destinacio || "GM Figaró",

      d.lloc_adreca || null, d.lloc_municipi || "Figaró-Montmany",
      d.lloc_comarca || "Vallès Oriental", d.lloc_tipus || null, d.lloc_nom_extra || null,

      d.persona_cognom1 || null, d.persona_cognom2 || null, d.persona_nom || null,
      d.persona_doc_tipus || null, d.persona_doc_num || null,
      d.persona_naix_data || null, d.persona_naix_loc || null,
      d.persona_naix_comarca || null, d.persona_naix_pais || "Espanya",
      d.persona_nom_pare || null, d.persona_nom_mare || null,
      d.persona_adreca || null, d.persona_municipi || null,
      d.persona_comarca || null, d.persona_tel || null,
      d.persona_adreca_t || null, d.persona_municipi_t || null,
      d.persona_tel_t || null, d.persona_fi_t || null,
      d.persona_menor ? 1 : 0, d.persona_hm_id || null,

      d.vehicle_matricula || null, d.vehicle_marca || null,
      d.vehicle_model || null, d.vehicle_asseguradora || null,
      d.conductor_nom || null, d.conductor_dni || null,

      d.article_infringit || null,

      d.text_fets.trim(),
      d.observacions || null,
      JSON.stringify(d.camps_extra || {}),

      req.user.username
    );

    // Audit
    db.prepare(`INSERT INTO actes_audit (acta_id, accio, agent, detall) VALUES (?,?,?,?)`)
      .run(result.lastInsertRowid, "CREAR", req.user.username, `Acta ${num} creada`);

    
// === RETROALIMENTACIÓ A hermano_mayor.db ===
    if (d.persona_hm_id) {
      const updateData = {};
      
      if (d.persona_naix_data && d.persona_naix_data.trim()) 
        updateData.fecha_nacimiento = d.persona_naix_data;
      if (d.persona_naix_loc && d.persona_naix_loc.trim()) 
        updateData.localidad_nacimiento = d.persona_naix_loc;
      if (d.persona_naix_comarca && d.persona_naix_comarca.trim()) 
        updateData.comarca_nacimiento = d.persona_naix_comarca;
      if (d.persona_nom_pare && d.persona_nom_pare.trim()) 
        updateData.nombre_padre = d.persona_nom_pare;
      if (d.persona_nom_mare && d.persona_nom_mare.trim()) 
        updateData.nombre_madre = d.persona_nom_mare;
      if (d.persona_adreca && d.persona_adreca.trim()) 
        updateData.direccion = d.persona_adreca;
      if (d.persona_tel && d.persona_tel.trim()) 
        updateData.telefono = d.persona_tel;

      if (Object.keys(updateData).length > 0) {
        const hm = getHmDb();
        if (hm) {
          try {
            const updates = Object.keys(updateData).map(k => `${k} = ?`).join(", ");
            const values = Object.values(updateData);
            values.push(d.persona_hm_id);
            
            const changed = hm.prepare(
              `UPDATE persons SET ${updates} WHERE id = ?`
            ).run(...values);
            
            if (changed.changes > 0) {
              console.log(`✓ Retroalimentació HM: persona ${d.persona_hm_id} actualitzada (${changed.changes} camps)`);
              db.prepare(`INSERT INTO actes_audit (acta_id, accio, agent, detall) VALUES (?,?,?,?)`)
                .run(result.lastInsertRowid, "SYNC_HM", req.user.username, 
                     `Actualitzats ${changed.changes} camps a hermano_mayor`);
            }
          } catch(e) {
            console.warn("Error retroalimentació hermano_mayor:", e.message);
          }
        }
      }
    }
    
    res.status(201).json({ ok: true, num_registre: num, id: result.lastInsertRowid });

  } catch(e) {
    console.error("Error creant acta:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================================
// SHERLOCK — cerca/alta persona a hermano_mayor.db
// ============================================================================

let hmDb = null;
function getHmDb() {
  if (hmDb) return hmDb;
  if (existsSync(HERMANO_DB_PATH)) {
    hmDb = new Database(HERMANO_DB_PATH);
    console.log("✓ hermano_mayor.db connectada");
  }
  return hmDb;
}

// Cerca persona
app.post("/api/actes/persona/cerca", requireAuth, (req, res) => {
  const { q } = req.body;
  if (!q || q.trim().length < 2)
    return res.status(400).json({ ok: false, error: "Mínim 2 caràcters per cercar" });

  const hm = getHmDb();
  if (!hm) return res.json({ ok: true, persones: [], warn: "hermano_mayor.db no disponible" });

  const s = `%${q.trim().toUpperCase()}%`;
  // Primer intent: amb columnes opcionals nombre_padre/nombre_madre si existeixen
  let persones;
  try {
    persones = hm.prepare(`
      SELECT id, nombre, apellidos, dni, fecha_nacimiento,
             direccion, telefono, observaciones,
             nombre_padre, nombre_madre
      FROM persons
      WHERE UPPER(apellidos) LIKE ? OR UPPER(nombre) LIKE ? OR dni LIKE ?
      LIMIT 10
    `).all(s, s, `%${q.trim()}%`);
  } catch(e) {
    // Fallback: sense columnes opcionals (versió hermano_mayor sense pare/mare)
    try {
      persones = hm.prepare(`
        SELECT id, nombre, apellidos, dni, fecha_nacimiento,
               direccion, telefono, observaciones
        FROM persons
        WHERE UPPER(apellidos) LIKE ? OR UPPER(nombre) LIKE ? OR dni LIKE ?
        LIMIT 10
      `).all(s, s, `%${q.trim()}%`);
    } catch(e2) {
      return res.json({ ok: true, persones: [], warn: "Error consultant hermano_mayor: " + e2.message });
    }
  }
  res.json({ ok: true, persones });
});

// Alta nova persona a hermano_mayor.db
app.post("/api/actes/persona/alta", requireAuth, (req, res) => {
  const d = req.body;
  if (!d.nombre || !d.apellidos)
    return res.status(400).json({ ok: false, error: "nom i cognoms obligatoris" });

  const hm = getHmDb();
  if (!hm) return res.status(503).json({ ok: false, error: "hermano_mayor.db no disponible" });

  try {
    const result = hm.prepare(`
      INSERT INTO persons (nombre, apellidos, dni, fecha_nacimiento, direccion, telefono)
      VALUES (?,?,?,?,?,?)
    `).run(
      d.nombre.trim(), d.apellidos.trim(), d.dni || null,
      d.fecha_nacimiento || null,
      d.direccion || null, d.telefono || null
    );
    res.status(201).json({ ok: true, id: result.lastInsertRowid });
  } catch(e) {
    if (e.message.includes("UNIQUE")) {
      return res.status(409).json({ ok: false, error: "Ja existeix una persona amb aquest DNI" });
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Actualitzar dades persona a hermano_mayor.db (retroalimentació)
app.post("/api/actes/persona/update", requireAuth, (req, res) => {
  const d = req.body;
  
  if (!d.dni && !d.id)
    return res.status(400).json({ ok: false, error: "Cal DNI o ID per actualitzar" });

  const hm = getHmDb();
  if (!hm) return res.status(503).json({ ok: false, error: "hermano_mayor.db no disponible" });

  try {
    const updates = [];
    const params = [];

    if (d.fecha_nacimiento !== undefined) {
      updates.push("fecha_nacimiento = ?");
      params.push(d.fecha_nacimiento || null);
    }
    if (d.localidad_nacimiento !== undefined) {
      updates.push("localidad_nacimiento = ?");
      params.push(d.localidad_nacimiento || null);
    }
    if (d.comarca_nacimiento !== undefined) {
      updates.push("comarca_nacimiento = ?");
      params.push(d.comarca_nacimiento || null);
    }
    if (d.nombre_padre !== undefined) {
      updates.push("nombre_padre = ?");
      params.push(d.nombre_padre || null);
    }
    if (d.nombre_madre !== undefined) {
      updates.push("nombre_madre = ?");
      params.push(d.nombre_madre || null);
    }
    if (d.direccion !== undefined) {
      updates.push("direccion = ?");
      params.push(d.direccion || null);
    }
    if (d.telefono !== undefined) {
      updates.push("telefono = ?");
      params.push(d.telefono || null);
    }

    if (updates.length === 0) {
      return res.json({ ok: true, message: "Cap camp per actualitzar" });
    }

    const whereClause = d.dni ? "dni = ?" : "id = ?";
    const whereValue = d.dni ? d.dni : d.id;
    params.push(whereValue);

    const sql = `UPDATE persons SET ${updates.join(", ")} WHERE ${whereClause}`;
    const result = hm.prepare(sql).run(...params);

    if (result.changes === 0) {
      return res.status(404).json({ ok: false, error: "Persona no trobada" });
    }

    res.json({ ok: true, changes: result.changes });

  } catch(e) {
    console.error("Error actualitzant persona:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});
// ============================================================================
// ARRANC
// ============================================================================
// ============================================================================
// Cerca local a hermano_mayor.locations (per A-46)
app.post("/api/actes/local/cerca", requireAuth, (req, res) => {
  const { q } = req.body;
  if (!q || q.trim().length < 2)
    return res.status(400).json({ ok: false, error: "Mínim 2 caràcters" });
  const hm = getHmDb();
  if (!hm) return res.json({ ok: true, locals: [], warn: "hermano_mayor.db no disponible" });
  try {
    const term = `%${q.trim().toLowerCase()}%`;
    const locals = hm.prepare(`
      SELECT id, canonical_name, adreca, telefon, categoria
      FROM locations
      WHERE (LOWER(canonical_name) LIKE ? OR LOWER(adreca) LIKE ?)
        AND actiu = 1
      ORDER BY canonical_name
      LIMIT 10
    `).all(term, term);
    res.json({ ok: true, locals });
  } catch(e) {
    res.json({ ok: true, locals: [], warn: "Error: " + e.message });
  }
});


// ============================================================================

const TEMPLATES_DIR = "/srv/police/actes-backend/templates";

function buildCtx(acta) {
  const chk = (val, match) => (val || "") === match ? "☒" : "☐";
  let extra = {};
  try {
    const parsed = JSON.parse(acta.camps_extra || "{}");
    // Defensa contra double-encoding: si el frontend va enviar JSON.stringify(obj) en lloc d'obj
    extra = (typeof parsed === "string") ? JSON.parse(parsed) : parsed;
  } catch(e) {}

  return {
    num_registre:         acta.num_registre        || "",
    data_acta:            acta.data_acta            || "",
    hora_inici:           acta.hora_inici           || "",
    hora_fi:              acta.hora_fi              || "",
    tip_instructor:       acta.tip_instructor       || "",
    tip_secretari:        acta.tip_secretari        || "",
    destinacio:           acta.destinacio           || "GM Figaró",
    lloc_adreca:          acta.lloc_adreca          || "",
    lloc_municipi:        acta.lloc_municipi        || "Figaró-Montmany",
    lloc_comarca:         acta.lloc_comarca         || "Vallès Oriental",
    lloc_tipus:           acta.lloc_tipus           || "",
    lloc_nom_extra:       acta.lloc_nom_extra       || "",
    persona_cognom1:      acta.persona_cognom1      || "",
    persona_cognom2:      acta.persona_cognom2      || "",
    persona_nom:          acta.persona_nom          || "",
    persona_doc_tipus:    acta.persona_doc_tipus    || "",
    persona_doc_num:      acta.persona_doc_num      || "",
    persona_naix_data:    acta.persona_naix_data    || "",
    persona_naix_loc:     acta.persona_naix_loc     || "",
    persona_naix_comarca: acta.persona_naix_comarca || "",
    persona_naix_pais:    acta.persona_naix_pais    || "Espanya",
    persona_nom_pare:     acta.persona_nom_pare     || "",
    persona_nom_mare:     acta.persona_nom_mare     || "",
    persona_adreca:       acta.persona_adreca       || "",
    persona_municipi:     acta.persona_municipi     || "",
    persona_comarca:      acta.persona_comarca      || "",
    persona_tel:          acta.persona_tel          || "",
    persona_adreca_t:     acta.persona_adreca_t     || "",
    persona_municipi_t:   acta.persona_municipi_t   || "",
    persona_tel_t:        acta.persona_tel_t        || "",
    persona_fi_t:         acta.persona_fi_t         || "",
    text_fets:            acta.text_fets            || "",
    observacions:         acta.observacions         || "",
    
    // === A-10: Checkboxes capçalera i data final ===
    chk_ofici:       chk(extra.tipus_acta, "ofici"),
    chk_ordre:       chk(extra.tipus_acta, "ordre"),
    chk_requeriment: chk(extra.tipus_acta, "requeriment"),
    // === A-46: Acta d'infracció d'horari ===
    // Local — prioritza lookup HM; fallback a camps_extra (entrada manual)
    nom_local:              acta._nom_local          || extra.nom_local_manual || "",
    activitat_local:        extra.activitat_local    || "",
    telefon_local:          acta._telefon_local      || extra.telefon_local   || "",

    // Titular del local
    titular_nom:            extra.titular_nom             || "",
    titular_doc_tipus:      extra.titular_doc_tipus       || "",
    titular_doc_num:        extra.titular_doc_num         || "",
    titular_nom_responsable: extra.titular_nom_responsable || "",
    titular_nom_pare:       extra.titular_nom_pare        || "",
    titular_nom_mare:       extra.titular_nom_mare        || "",
    titular_naix_data:      extra.titular_naix_data       || "",
    titular_naix_loc:       extra.titular_naix_loc        || "",
    titular_adreca:         extra.titular_adreca          || "",
    titular_municipi:       extra.titular_municipi        || "",
    titular_tel:            extra.titular_tel             || "",
    titular_doc_tipus_resp: extra.titular_doc_tipus       || "",
    // Camps filiatoris titular (recollits via modal titular al frontend)
    titular_naix_comarca:   extra.titular_naix_comarca    || "",
    titular_naix_pais:      extra.titular_naix_pais       || "Espanya",
    titular_comarca:        extra.titular_comarca         || "",

    // Inspecció
    llicencia_activitat:    extra.llicencia_activitat || "",
    llicencia_data:         extra.llicencia_data      || "",
    llicencia_num_exp:      extra.llicencia_num_exp   || "",
    aforament_num:          extra.aforament_num        || "",
    asseguradora:           extra.asseguradora         || "",
    polissa_num:            extra.polissa_num          || "",
    polissa_caducitat:      extra.polissa_caducitat    || "",
    polissa_import:         extra.polissa_import       || "",
    persones_dins:          extra.persones_dins        || "",

    // Checkboxes
    chk_llicencia_si:  chk(extra.llicencia, "si"),
    chk_llicencia_no:  chk(extra.llicencia, "no"),
    chk_polissa_si:    chk(extra.polissa,   "si"),
    chk_polissa_no:    chk(extra.polissa,   "no"),
    chk_obert_si:      chk(extra.obert,     "si"),
    chk_obert_no:      chk(extra.obert,     "no"),
    chk_musica_si:     chk(extra.musica,    "si"),
    chk_musica_no:     chk(extra.musica,    "no"),
    chk_begudes_si:    chk(extra.begudes,   "si"),
    chk_begudes_no:    chk(extra.begudes,   "no"),
    chk_llums_si:      chk(extra.llums,     "si"),
    chk_llums_no:      chk(extra.llums,     "no"),

    // === A-09: Vehicle abandonat ===
    cotxe_matricula:   extra.cotxe_matricula  || "",
    cotxe_marca:       extra.cotxe_marca      || "",
    cotxe_model:       extra.cotxe_model      || "",
    cotxe_color:       extra.cotxe_color      || "",
    cotxe_bastidor:    extra.cotxe_bastidor   || "",
    text_fets:         extra.text_fets        || "",
    destinacio:        extra.destinacio       || "",
    // Danys vehicle — checkboxes zona present/absent
    chk_fas:           chk(extra.v_fas,       "si"),
    chk_farsd:         chk(extra.v_farsd,     "si"),
    chk_capo:          chk(extra.v_capo,      "si"),
    txt_capo:          extra.txt_capo         || "",
    chk_portes:        chk(extra.v_portes,    "si"),
    txt_portes_dav:    extra.txt_portes_dav   || "",
    chk_portesd:       chk(extra.v_portesd,   "si"),
    txt_portes_darr:   extra.txt_portes_darr  || "",
    chk_vidres:        chk(extra.v_vidres,    "si"),
    txt_vidres:        extra.txt_vidres       || "",
    chk_retro:         chk(extra.v_retro,     "si"),
    txt_retros:        extra.txt_retros       || "",
    chk_sostre:        chk(extra.v_sostre,    "si"),
    "txt_sostre ":     extra.txt_sostre       || "",
    chk_rodes:         chk(extra.v_rodes,     "si"),
    txt_rodes_num:     extra.txt_rodes_num    || "",
    chk_maleter:       chk(extra.v_maleter,   "si"),
    txt_maleter:       extra.txt_maleter      || "",
    chk_inter:         chk(extra.v_inter,     "si"),
    txt_int_dav:       extra.txt_int_dav      || "",
    chk_interd:        chk(extra.v_interd,    "si"),
    txt_int_darr:      extra.txt_int_darr     || "",
    chk_danys_int:     chk(extra.v_danys_int, "si"),
    txt_sanys_int:     extra.txt_sanys_int    || "",
    chk_matricules:    chk(extra.v_matricules,"si"),
    txt_matricules:    extra.txt_matricules   || "",
    chk_obert:         chk(extra.v_obert,     "si"),
    chk_sip:           chk(extra.v_sip,       "si"),
    chk_itv:           chk(extra.v_itv,       "si"),
    chk_noass:         chk(extra.v_noass,     "si"),
    chk_baixadm:       chk(extra.v_baixadm,   "si"),

    // === A-13 / A-13b: Precinte / Desprecinte vehicle ===
    // cotxe_* i chk_* compartits amb A-09 (ja definits)
    multa_exp:         extra.multa_exp        || "",
    multa_article:     extra.multa_article    || "",
    multa_text:        extra.multa_text       || "",
    text_danys:        extra.text_danys       || "",
    // Categoria permís
    chk_A:             chk(extra.perm_cat,    "A"),
    chk_A1:            chk(extra.perm_cat,    "A1"),
    chk_A2:            chk(extra.perm_cat,    "A2"),
    chk_AM:            chk(extra.perm_cat,    "AM"),
    chk_B:             chk(extra.perm_cat,    "B"),
    chk_B1:            chk(extra.perm_cat,    "B1"),
    chk_c1:            chk(extra.perm_cat,    "c1"),
    chk_d1:            chk(extra.perm_cat,    "d1"),
    chk_d:             chk(extra.perm_cat,    "d"),
    chk_E:             chk(extra.perm_cat,    "E"),
    "chk_":            chk(extra.perm_cat,    ""),
    // Mesures cautelars
    chk_immob:         chk(extra.mesura,      "immob"),
    chk_cepo:          chk(extra.mesura,      "cepo"),
    chk_diposit:       chk(extra.mesura,      "diposit"),
    chk_custo:         chk(extra.mesura,      "custo"),
    chk_crua:          chk(extra.mesura,      "crua"),
    chk_pito:          chk(extra.mesura,      "pito"),
    // conductor (persona_cond_*)
    persona_cond_nom:           extra.cond_nom           || "",
    persona_cond_cognom1:       extra.cond_cognom1       || "",
    persona_cond_cognom2:       extra.cond_cognom2       || "",
    persona_cond_doc_tipus:     extra.cond_doc_tipus     || "",
    persona_cond_doc_num:       extra.cond_doc_num       || "",
    persona_cond_naix_data:     extra.cond_naix_data     || "",
    persona_cond_naix_loc:      extra.cond_naix_loc      || "",
    persona_cond_naix_comarca:  extra.cond_naix_comarca  || "",
    persona_cond_naix_pais:     extra.cond_naix_pais     || "Espanya",
    persona_cond_nom_pare:      extra.cond_nom_pare      || "",
    persona_cond_nom_mare:      extra.cond_nom_mare      || "",
    persona_cond_adreca:        extra.cond_adreca        || "",
    persona_cond_municipi:      extra.cond_municipi      || "",
    persona_cond_comarca:       extra.cond_comarca       || "",
    persona_cond_tel:           extra.cond_tel           || "",

    // === A-14 / A-14b: Precinte / Desprecinte local ===
    text_jutjat:       extra.text_jutjat      || "",
    text_num_auto:     extra.text_num_auto    || "",
    text_ordre:        extra.text_ordre       || "",
    chk_auto_judici:   chk(extra.auto_judici, "si"),
    text_cotxe_marca:  extra.text_cotxe_marca || "",
    text_cotxe_model:  extra.text_cotxe_model || "",
    text_cotxe_matri:  extra.text_cotxe_matri || "",
    text_cotxe_color:  extra.text_cotxe_color || "",
    text_cotxe_tipus:  extra.text_cotxe_tipus || "",
    text_cotxe_nac:    extra.text_cotxe_nac   || "",
    text_cotxe_km:     extra.text_cotxe_km    || "",
    text_precinte1:    extra.text_precinte1   || "",
    text_precinte2:    extra.text_precinte2   || "",
    text_precinte3:    extra.text_precinte3   || "",
    text_precinte4:    extra.text_precinte4   || "",
    text_precinte5:    extra.text_precinte5   || "",
    text_precinte6:    extra.text_precinte6   || "",
    text_precinte7:    extra.text_precinte7   || "",
    text_precinte8:    extra.text_precinte8   || "",
    // A-14b / A-15: establiment
    text_nom_establiment: extra.text_nom_establiment || "",
    chk_bar:           chk(extra.tipus_estab, "bar"),
    chk_barM:          chk(extra.tipus_estab, "barM"),
    chk_rest:          chk(extra.tipus_estab, "rest"),
    chk_disco:         chk(extra.tipus_estab, "disco"),
    chk_locu:          chk(extra.tipus_estab, "locu"),
    chk_comerc:        chk(extra.tipus_estab, "comerc"),
    chk_altres:        chk(extra.tipus_estab, "altres"),
    text_altres:       extra.text_altres      || "",

    // === A-205 / A-206: Recollida / Entrega d'animal ===
    TXT_RAZA:          extra.animal_raca     || "",
    TXT_COLOR:         extra.animal_color    || "",
    XIP_NUMERO:        extra.animal_xip_num  || "",
    // Espècie
    chk_GOS:           chk(extra.animal_especie, "gos"),
    chk_GAT:           chk(extra.animal_especie, "gat"),
    chk_ALTRES:        chk(extra.animal_especie, "altres"),
    // Sexe
    chk_MASCLE:        chk(extra.animal_sexe, "mascle"),
    chk_FEMELLA:       chk(extra.animal_sexe, "femella"),
    // Talla
    chk_GRAN:          chk(extra.animal_talla, "gran"),
    chk_MITJA:         chk(extra.animal_talla, "mitja"),
    chk_PETIT:         chk(extra.animal_talla, "petit"),
    // Pèl
    chk_PEL_CURT:      chk(extra.animal_pel, "curt"),
    chk_PEL_LLARG:     chk(extra.animal_pel, "llarg"),
    // Xip identificador
    chk_XIP_si:        chk(extra.animal_xip, "si"),
    chk_XIP_NO:        chk(extra.animal_xip, "no"),
  };
}

// Descarregar .docx generat
app.get("/api/actes/:id/generar-word", requireAuth, (req, res) => {
  const acta = db.prepare("SELECT * FROM actes WHERE id = ? OR num_registre = ?")
                 .get(req.params.id, req.params.id);
  if (!acta) return res.status(404).json({ ok: false, error: "Acta no trobada" });

  // A-46: enriquir amb dades del local des de hermano_mayor.locations
  if (acta.codi_acta === "A-46") {
    try {
      const extra = JSON.parse(acta.camps_extra || "{}");
      if (extra.local_hm_id) {
        // Cas 1: local vinculat a hermano_mayor.locations
        const hm = getHmDb();
        if (hm) {
          const local = hm.prepare(
            "SELECT canonical_name, adreca, telefon FROM locations WHERE id = ?"
          ).get(extra.local_hm_id);
          if (local) {
            acta._nom_local     = local.canonical_name || "";
            acta._telefon_local = local.telefon        || "";
            if (!acta.lloc_adreca) acta.lloc_adreca = local.adreca || "";
          }
        }
      } else {
        // Cas 2: local introduït manualment (sense vincle HM)
        // nom_local i telefon_local vénen de camps_extra via buildCtx
        // No cal fer res aquí — buildCtx els llegeix directament d'extra
        acta._nom_local     = "";
        acta._telefon_local = "";
      }
    } catch(e) {
      console.warn("A-46 local lookup error:", e.message);
    }
  }

  const templatePath = path.join(TEMPLATES_DIR, `${acta.codi_acta}.docx`);
  if (!fs.existsSync(templatePath))
    return res.status(404).json({ ok: false, error: `Template ${acta.codi_acta}.docx no trobat a ${TEMPLATES_DIR}` });

  try {
    const rawContent = fs.readFileSync(templatePath);
    const zip = new PizZip(rawContent);

    // Substituir variables directament al XML — sense docxtemplater
    let xml = zip.files["word/document.xml"].asText();
    xml = renderXml(xml, buildCtx(acta));
    zip.file("word/document.xml", xml);

    const buf = zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
    const filename = `${acta.num_registre}-${acta.codi_acta}.docx`.replace(/[^a-zA-Z0-9\-_.]/g, "_");
    db.prepare("INSERT INTO actes_audit (acta_id, accio, agent, detall) VALUES (?,?,?,?)")
      .run(acta.id, "GENERAR_WORD", req.user.username, filename);
    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": buf.length
    });
    res.send(buf);
  } catch(e) {
    console.error("Word error:", e.message);
    res.status(500).json({ ok: false, error: "Error generant el Word: " + e.message });
  }
});

// Preview HTML (previsualitzar abans de descarregar)
app.get("/api/actes/:id/preview", requireAuth, (req, res) => {
  const acta = db.prepare("SELECT * FROM actes WHERE id = ? OR num_registre = ?")
                 .get(req.params.id, req.params.id);
  if (!acta) return res.status(404).json({ ok: false, error: "Acta no trobada" });

  const ctx = buildCtx(acta);

  const persona = (acta.persona_cognom1 || acta.persona_doc_num)
    ? [acta.persona_cognom1, acta.persona_cognom2].filter(Boolean).join(" ") + (acta.persona_nom ? ", " + acta.persona_nom : "")
    : null;

  const S = (v) => (v || "").toString().replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const SP = (v) => S(v).replace(/\n/g,"<br>");

  const html = `<div style="font-family:Arial,sans-serif;font-size:12px;max-width:700px;margin:0 auto">
    <div style="text-align:center;border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:12px">
      <strong>GUÀRDIA MUNICIPAL DE FIGARÓ-MONTMANY</strong><br>
      <span style="font-size:10px">CT de Ribes 42-44 · 08590 Figaró-Montmany · Tel. 93-842-9111</span><br>
      <strong style="font-size:13px">${S(acta.titol_acta || acta.codi_acta)} · ${S(acta.codi_acta)}</strong>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:11px;margin-bottom:8px">
      <tr>
        <td style="border:1px solid #000;padding:4px 6px"><strong>Núm. acta</strong><br>${S(acta.num_registre)}</td>
        <td style="border:1px solid #000;padding:4px 6px"><strong>Data</strong><br>${S(acta.data_acta)}</td>
        <td style="border:1px solid #000;padding:4px 6px"><strong>Hora inici</strong><br>${S(acta.hora_inici)}</td>
        ${acta.hora_fi ? `<td style="border:1px solid #000;padding:4px 6px"><strong>Hora fi</strong><br>${S(acta.hora_fi)}</td>` : ""}
      </tr>
      <tr>
        <td style="border:1px solid #000;padding:4px 6px" colspan="2"><strong>Instructor/a</strong><br>TIP ${S(acta.tip_instructor)}${acta.tip_secretari ? ` / Secretari/ària: TIP ${S(acta.tip_secretari)}` : ""}</td>
        <td style="border:1px solid #000;padding:4px 6px" colspan="2"><strong>Unitat</strong><br>${S(acta.destinacio)}</td>
      </tr>
    </table>
    ${acta.codi_acta === "A-10" ? `
    <div style="border:1px solid #000;padding:5px 6px;margin-bottom:6px;font-size:11px">
      <strong>TIPUS D'ACTA:</strong> &nbsp;&nbsp;
      ${ctx.chk_ofici} Ofici &nbsp;&nbsp;&nbsp;
      ${ctx.chk_ordre} Ordre d'inici d'expedient &nbsp;&nbsp;&nbsp;
      ${ctx.chk_requeriment} Requeriment
    </div>` : ""}
    ${acta.codi_acta === "A-46" ? `
    <div style="border:1px solid #000;padding:5px 6px;margin-bottom:6px;font-size:11px">
      <strong>INSPECCIÓ:</strong><br>
      Llicència activitat: ${ctx.chk_llicencia_si} Sí ${ctx.chk_llicencia_no} No &nbsp;&nbsp;&nbsp;
      Pòlissa RC: ${ctx.chk_polissa_si} Sí ${ctx.chk_polissa_no} No &nbsp;&nbsp;&nbsp;
      Obert: ${ctx.chk_obert_si} Sí ${ctx.chk_obert_no} No<br>
      Música: ${ctx.chk_musica_si} Sí ${ctx.chk_musica_no} No &nbsp;&nbsp;&nbsp;
      Begudes: ${ctx.chk_begudes_si} Sí ${ctx.chk_begudes_no} No &nbsp;&nbsp;&nbsp;
      Llums: ${ctx.chk_llums_si} Sí ${ctx.chk_llums_no} No
    </div>` : ""}
    ${["A-205","A-206"].includes(acta.codi_acta) ? (() => { const e = (typeof acta.camps_extra === "object" ? acta.camps_extra : {}); return `
    <div style="border:1px solid #000;padding:5px 6px;margin-bottom:6px;font-size:11px">
      <strong>DADES DE L'ANIMAL:</strong><br>
      <strong>Espècie:</strong> ${ctx.chk_GOS} Gos &nbsp; ${ctx.chk_GAT} Gat &nbsp; ${ctx.chk_ALTRES} Altres &nbsp;&nbsp;&nbsp;
      <strong>Sexe:</strong> ${ctx.chk_MASCLE} Mascle &nbsp; ${ctx.chk_FEMELLA} Femella<br>
      <strong>Talla:</strong> ${ctx.chk_GRAN} Gran &nbsp; ${ctx.chk_MITJA} Mitjana &nbsp; ${ctx.chk_PETIT} Petita &nbsp;&nbsp;&nbsp;
      <strong>Pèl:</strong> ${ctx.chk_PEL_CURT} Curt &nbsp; ${ctx.chk_PEL_LLARG} Llarg<br>
      <strong>Raça:</strong> ${S(ctx.TXT_RAZA||"—")} &nbsp;&nbsp;&nbsp; <strong>Color:</strong> ${S(ctx.TXT_COLOR||"—")}<br>
      <strong>Xip:</strong> ${ctx.chk_XIP_si} Sí &nbsp; ${ctx.chk_XIP_NO} No ${ctx.XIP_NUMERO ? "&nbsp;&nbsp; Núm: "+S(ctx.XIP_NUMERO) : ""}
    </div>`; })() : ""}
    ${acta.codi_acta === "A-09" ? (() => { const e = (typeof acta.camps_extra === "object" ? acta.camps_extra : {}); return `
    <div style="border:1px solid #000;padding:5px 6px;margin-bottom:6px;font-size:11px">
      <strong>VEHICLE ABANDONAT:</strong><br>
      <strong>Matrícula:</strong> ${S(ctx.cotxe_matricula||"—")} &nbsp; <strong>Marca/Model:</strong> ${S(ctx.cotxe_marca)} ${S(ctx.cotxe_model)} &nbsp; <strong>Color:</strong> ${S(ctx.cotxe_color||"—")}<br>
      <strong>Bastidor:</strong> ${S(ctx.cotxe_bastidor||"—")} &nbsp;&nbsp; <strong>Destinació:</strong> ${S(ctx.destinacio||"—")}
    </div>`; })() : ""}
    ${["A-13","A-13b"].includes(acta.codi_acta) ? (() => { const e = (typeof acta.camps_extra === "object" ? acta.camps_extra : {}); return `
    <div style="border:1px solid #000;padding:5px 6px;margin-bottom:6px;font-size:11px">
      <strong>${acta.codi_acta === "A-13" ? "PRECINTE" : "DESPRECINTE"} VEHICLE:</strong><br>
      <strong>Matrícula:</strong> ${S(ctx.cotxe_matricula||"—")} &nbsp; <strong>Marca/Model:</strong> ${S(ctx.cotxe_marca)} ${S(ctx.cotxe_model)} &nbsp; <strong>Color:</strong> ${S(ctx.cotxe_color||"—")}<br>
      <strong>Exp. multa:</strong> ${S(ctx.multa_exp||"—")} &nbsp; <strong>Article:</strong> ${S(ctx.multa_article||"—")}<br>
      <strong>Mesura:</strong> ${ctx.chk_immob}Immob. ${ctx.chk_cepo}Cep ${ctx.chk_diposit}Dipòsit ${ctx.chk_custo}Custòdia ${ctx.chk_crua}CRUA ${ctx.chk_pito}Pitó
    </div>`; })() : ""}
    ${["A-14","A-14b"].includes(acta.codi_acta) ? (() => { const e = (typeof acta.camps_extra === "object" ? acta.camps_extra : {}); return `
    <div style="border:1px solid #000;padding:5px 6px;margin-bottom:6px;font-size:11px">
      <strong>${acta.codi_acta === "A-14" ? "PRECINTE" : "DESPRECINTE"} LOCAL:</strong><br>
      <strong>Jutjat:</strong> ${S(ctx.text_jutjat||"—")} &nbsp; <strong>Auto núm.:</strong> ${S(ctx.text_num_auto||"—")} &nbsp; <strong>Ordre:</strong> ${S(ctx.text_ordre||"—")}<br>
      <strong>Precintes:</strong> ${[1,2,3,4,5,6,7,8].map(n=>ctx["text_precinte"+n]||"").filter(Boolean).join(" · ")||"—"}
    </div>`; })() : ""}
    ${acta.codi_acta === "A-205" ? (() => { const e = (typeof acta.camps_extra === "object" ? acta.camps_extra : {}); return `
    <div style="border:1px solid #000;padding:5px 6px;margin-bottom:6px;font-size:11px">
      <strong>DADES DE L'ANIMAL:</strong><br>
      <strong>Espècie:</strong> ${ctx.chk_GOS} Gos &nbsp; ${ctx.chk_GAT} Gat &nbsp; ${ctx.chk_ALTRES} Altres &nbsp;&nbsp;&nbsp;
      <strong>Sexe:</strong> ${ctx.chk_MASCLE} Mascle &nbsp; ${ctx.chk_FEMELLA} Femella<br>
      <strong>Talla:</strong> ${ctx.chk_GRAN} Gran &nbsp; ${ctx.chk_MITJA} Mitjana &nbsp; ${ctx.chk_PETIT} Petita &nbsp;&nbsp;&nbsp;
      <strong>Pèl:</strong> ${ctx.chk_PEL_CURT} Curt &nbsp; ${ctx.chk_PEL_LLARG} Llarg<br>
      <strong>Raça:</strong> ${S(ctx.TXT_RAZA || "—")} &nbsp;&nbsp;&nbsp;
      <strong>Color:</strong> ${S(ctx.TXT_COLOR || "—")}<br>
      <strong>Xip:</strong> ${ctx.chk_XIP_si} Sí &nbsp; ${ctx.chk_XIP_NO} No
      ${ctx.XIP_NUMERO ? `&nbsp;&nbsp;&nbsp; <strong>Núm. xip:</strong> ${S(ctx.XIP_NUMERO)}` : ""}
    </div>`; })() : ""}
    <div style="border:1px solid #000;padding:5px 6px;margin-bottom:6px;font-size:11px">
      <strong>LLOC:</strong> ${S(acta.lloc_adreca)} · ${S(acta.lloc_municipi)} · ${S(acta.lloc_comarca)}
      ${acta.lloc_tipus ? ` · <em>${S(acta.lloc_tipus)}${acta.lloc_nom_extra ? " - " + S(acta.lloc_nom_extra) : ""}</em>` : ""}
    </div>
    ${persona ? `<div style="border:1px solid #000;padding:5px 6px;margin-bottom:6px;font-size:11px">
      <strong>PERSONA:</strong> ${S(persona)}${acta.persona_doc_num ? ` &nbsp;·&nbsp; <strong>${S(acta.persona_doc_tipus||"Doc")}</strong>: ${S(acta.persona_doc_num)}` : ""}
      ${acta.persona_naix_data ? ` &nbsp;·&nbsp; Naix.: ${S(acta.persona_naix_data)}` : ""}
      ${acta.persona_adreca ? `<br>${S(acta.persona_adreca)}${acta.persona_municipi ? ", " + S(acta.persona_municipi) : ""}` : ""}
      ${acta.persona_tel ? ` &nbsp;·&nbsp; Tel.: ${S(acta.persona_tel)}` : ""}
      ${(acta.persona_nom_pare || acta.persona_nom_mare) ? `<br>Pare: ${S(acta.persona_nom_pare)} &nbsp;·&nbsp; Mare: ${S(acta.persona_nom_mare)}` : ""}
    </div>` : ""}
    <div style="border:1px solid #000;padding:5px 6px;margin-bottom:6px;min-height:140px;font-size:11px">
      <strong>CONTINGUT DE L'ACTA</strong><br><br>
      <div style="white-space:pre-wrap;line-height:1.6">${SP(acta.text_fets)}</div>
    </div>
    ${acta.observacions ? `<div style="border:1px solid #000;padding:5px 6px;margin-bottom:6px;font-size:11px">
      <strong>OBSERVACIONS</strong><br><div style="white-space:pre-wrap">${SP(acta.observacions)}</div>
    </div>` : ""}
    <div style="border:1px solid #000;padding:5px 6px;margin-bottom:6px;font-size:11px">
      <strong>SIGNATURES</strong>
      <table style="width:100%;margin-top:12px">
        <tr>
          <td style="width:33%;text-align:center;padding:28px 4px 4px;border-top:1px solid #000;font-size:10px">Instructor/a<br>TIP ${S(acta.tip_instructor)}</td>
          ${acta.tip_secretari ? `<td style="width:33%;text-align:center;padding:28px 4px 4px;border-top:1px solid #000;font-size:10px">Secretari/ària<br>TIP ${S(acta.tip_secretari)}</td>` : ""}
          <td style="width:33%;text-align:center;padding:28px 4px 4px;border-top:1px solid #000;font-size:10px">Persona interessada${acta.persona_doc_num ? `<br><span style="font-family:monospace">${S(acta.persona_doc_num)}</span>` : ""}</td>
          <td style="width:33%;text-align:center;padding:28px 4px 4px;border-top:1px solid #000;font-size:10px">Testimoni/s</td>
        </tr>
      </table>
    </div>
    <div style="font-size:9px;color:#666;margin-top:8px;padding-top:6px;border-top:1px solid #ddd">
      En compliment de l'article 5 de la Llei 15/1999, de protecció de dades de caràcter personal, us informem que les dades s'inclouran als fitxers SIP PF i/o SIP PFMEN.
    </div>
  </div>`;

  res.json({ ok: true, html, num_registre: acta.num_registre, codi_acta: acta.codi_acta });
});

function renderXml(xml, ctx) {
  xml = xml.replace(/<w:proofErr[^/]*\/>/g, "");

  // Word splits variables across runs — merge adjacent runs (amb i sense rPr).
  // 5 passes: cadenes llargues com {{#hora_fi}}{  {hora_fi}}{{/hora_fi}}
  for (let i = 0; i < 5; i++) {
    xml = xml.replace(/<\/w:t><\/w:r><w:r(?:\s[^>]*)?>(?:<w:rPr>(?:<[^>]*\/\s*>)*<\/w:rPr>)?<w:t(?:\s[^>]*)?>/g, "");
  }

  xml = xml.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (m, key, content) => {
    const val = ctx[key];
    return (val !== undefined && val !== null && val !== "") ? content : "";
  });
  xml = xml.replace(/\{\{(\w+)\}\}/g, (m, key) => {
    const val = ctx[key];
    if (val === undefined || val === null) return "";
    return String(val).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  });

  // Checkboxes → Wingdings DESPRES de la substitució estàndard.
  // El merge ha fusionat {{chk_x}} amb el text del label (ex: "{{chk_ofici}} Ofici" → "☒ Ofici").
  // Substituïm el RUN sencer: conservem l'etiqueta en un nou <w:r><w:t> separat.
  xml = xml.replace(
    /(<w:r(?:[^>]*)?>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?)<w:t[^>]*>(☒|☐)([^<]*)<\/w:t><\/w:r>/g,
    (m, runOpen, sym, rest) => {
      const char = sym === "☒" ? "00FE" : "00A8";
      const symRun = `${runOpen}<w:sym w:font="Wingdings" w:char="${char}"/></w:r>`;
      return rest ? `${symRun}<w:r><w:t xml:space="preserve">${rest}</w:t></w:r>` : symRun;
    }
  );

  return xml;
}

app.listen(PORT, () => {
  console.log(`🗂  Actes Backend al port ${PORT}`);
  console.log(`   → actes.db:   ${ACTES_DB_PATH}`);
  console.log(`   → users.db:   ${USERS_DB_PATH}`);
  console.log(`   → hermano_mayor.db: ${HERMANO_DB_PATH}`);
});
