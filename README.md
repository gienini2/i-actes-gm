# i·ACTES-GM — Digital Records System for Municipal Police

[![Node.js](https://img.shields.io/badge/Node.js-LTS-green)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4.x-lightgrey)](https://expressjs.com)
[![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-blue)](https://github.com/WiseLibs/better-sqlite3)
[![Status](https://img.shields.io/badge/status-production-brightgreen)]()

Web-based administrative records system built exclusively for a Municipal Police unit. Officers open a URL in any browser — no installation, no app, no npm — fill out a form, and get a ready-to-sign Word document in seconds.

**Live in production.** Accessed via Tailscale private network from any device on the unit's network.

---

## How it works

1. Officer opens the web page from any computer on the Tailscale network
2. Logs in with their badge number and PIN
3. Selects the act type (vehicle seizure, animal pickup, premises inspection...)
4. Fills in the form — person lookup pulls from the shared **hermano_mayor** database
5. Submits — the record is saved as immutable with a full audit trail
6. Downloads a pre-filled **.docx** ready to print and sign

Any new data collected (address, phone, date of birth, parents' names) is **automatically written back** to the officer's person record in hermano_mayor, keeping the central database up to date with zero extra effort.

---

## Zero-install deployment

The backend serves the HTML frontend as a static file. Officers need nothing installed — just a browser and Tailscale access. No npm, no build step, no Electron, no desktop app.

```
Officer's browser  ──Tailscale──▶  Linux server
                                   ├── Express (port 10002)
                                   ├── index.html  (served statically)
                                   ├── actes.db    (records)
                                   └── hermano_mayor.db  (persons, shared)
```

---

## Technical highlights

### Custom Word rendering engine

Word splits template variables across multiple XML runs when a `.docx` is manually edited. Standard libraries break on this. I wrote a custom engine that:

1. Strips spell-checker interference tags (`<w:proofErr>`)
2. Runs 5 passes merging adjacent XML runs to reconstruct split variables
3. Resolves `{{#block}}...{{/block}}` conditionals
4. Substitutes `{{variable}}` placeholders
5. Converts `☒` / `☐` Unicode into real embedded `w:sym` Wingdings — checkboxes look correct in every version of Word

> The Word templates were debugged using a **custom Claude skill** I built for this project: it reads the raw `.docx` XML and proposes the structural changes needed to make each template compatible with the renderer.

### Immutability by design

No `PUT` or `DELETE` endpoints exist. The schema has no `updated_at` column. Every record is append-only. A `CHECK` constraint enforces valid act codes. Every read, write and document download is logged to a dedicated audit table.

### Bidirectional person sync

When an act is saved with a linked person, any enriched data is written back to `hermano_mayor.db` — the shared SQLite database used across the whole ecosystem. Officers never fill in the same data twice.

### Shared auth

Sessions are validated against the central auth service with a 60-second in-memory cache, avoiding a network call on every request.

---

## Act types

| Code | Description | Word template |
|------|-------------|:---:|
| A-13 | Vehicle seizure | ✅ |
| A-13b | Vehicle unsealing | ✅ |
| A-14 | Premises seizure | ✅ |
| A-14b | Premises unsealing | ✅ |
| A-46 | Business inspection (license / hours) | ✅ |
| A-205 | Animal pickup | ✅ |
| A-206 | Animal return | ✅ |
| A-10, A-09, A-17… | Additional types | 🔄 |

---

## Stack

| | |
|--|--|
| Frontend | Single HTML file — vanilla JS, no framework, no build |
| Backend | Node.js · Express 4.x |
| Database | SQLite · better-sqlite3 |
| Documents | PizZip + custom XML substitution engine |
| Network | Tailscale (private mesh, no open ports) |
| Deployment | Linux · systemd service |

---

## Project structure

```
i-actes-gm/
├── server.js          # Full API + static file serving (~1,100 lines)
├── package.json
├── index.html         # Web UI — opened directly in the browser
├── templates/         # One .docx template per act code
│   ├── A-13.docx
│   ├── A-46.docx
│   └── ...
└── db/                # Auto-created at runtime — never committed
    └── actes.db
```

---

## Related projects

| Repo | Description |
|------|-------------|
| [sherlock-backend](../sherlock-backend) | Person search engine · hermano_mayor.db |
| [bitacola-backend](../bitacola-backend) | Duty log · central auth |
| [central](../central) | Entity parser · RAG on legal corpus |
| [i-actes-arboç](../i-actes-arboç) | Standalone Electron version for a separate unit |

---

## License

Internal use — Municipal Police unit.  
Commercial use prohibited without author's consent.
