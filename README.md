<p align="center">
  <img src="https://img.shields.io/badge/Hono.js-4.x-e36002?logo=hono&logoColor=white" alt="Hono.js" />
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/PostgreSQL-16-4169e1?logo=postgresql&logoColor=white" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/Drizzle_ORM-0.45-c5f74f?logo=drizzle&logoColor=black" alt="Drizzle ORM" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License MIT" />
</p>

# 💊 Apotek Digital — REST API Backend

> Backend API untuk sistem manajemen apotek digital, dibangun dengan Hono.js, TypeScript, PostgreSQL & Drizzle ORM. Mendukung multi-tenant, RBAC, dan integrasi Google Gemini AI.

---

## 📸 Integrasi Eksternal (SatuSehat Kemenkes & AI Gemini)

<p align="center">
  <img src="screenshots/foto3_satusehat_kemenkes.png" alt="Integrasi SatuSehat Kemenkes" width="90%" />
  <br/>
  <em>Sinkronisasi FHIR R4 MedicationDispense & KFA Kemenkes RI</em>
</p>

<p align="center">
  <img src="screenshots/foto4_ai_assistant_gemini.png" alt="AI Drug Interaction Checker" width="90%" />
  <br/>
  <em>Clinical Drug Interaction Checker & Smart Restock Bertenaga Google Gemini</em>
</p>

---

## ✨ Fitur API

- 🔐 **Authentication & RBAC** — JWT-based auth dengan role guard (owner / pharmacist / cashier)
- 🏢 **Multi-Tenant Isolation** — Data apotek terisolasi per `tenant_id`
- 📦 **Inventory Management** — Stok per batch, FEFO, konversi multi-satuan, transfer antar outlet
- 💰 **POS Transaction** — Checkout kasir, potong stok batch otomatis, shift management
- 🧾 **Purchase Management** — Faktur PBF, hutang dagang, surat pesanan
- 📊 **Reports & Accounting** — Omset harian, laba rugi, Pareto ABC, beban operasional
- 🤖 **AI Integration (Gemini)** — Chat farmakologi, cek interaksi obat, smart restock advisor
- 🏥 **SatuSehat / FHIR** — Integrasi pelaporan Kemenkes RI
- 👥 **Customer CRM** — Database pasien, riwayat PMR, pengingat obat

---

## 🛠️ Tech Stack

| Komponen | Teknologi |
|----------|-----------|
| **Runtime** | [Node.js](https://nodejs.org/) ≥ 18 |
| **Framework** | [Hono.js](https://hono.dev/) 4.x (ultra-fast web framework) |
| **Language** | [TypeScript](https://www.typescriptlang.org/) 5.x |
| **ORM** | [Drizzle ORM](https://orm.drizzle.team/) 0.45 (type-safe SQL) |
| **Database** | [PostgreSQL](https://www.postgresql.org/) 16 |
| **Validation** | [Zod](https://zod.dev/) |
| **Auth** | JWT ([jsonwebtoken](https://github.com/auth0/node-jsonwebtoken)) + bcrypt |
| **AI** | [Google Gemini](https://ai.google.dev/) Pro / Flash |
| **Build** | [tsup](https://tsup.egoist.dev/) + [tsx](https://github.com/privatenumber/tsx) |

---

## 📁 Struktur Project

```
apotek-digital-api/
├── src/
│   ├── index.ts                      # Hono server entry point + CORS
│   ├── config/
│   │   └── env.ts                    # Zod environment validation
│   ├── db/
│   │   ├── index.ts                  # Drizzle PostgreSQL client
│   │   └── schema/                   # 20 Database schemas
│   │       ├── tenants.ts            # Akun tenant apotek
│   │       ├── outlets.ts            # Cabang apotek
│   │       ├── users.ts              # User & RBAC roles
│   │       ├── products.ts           # Master obat & alkes
│   │       ├── product-units.ts      # Multi-satuan konversi
│   │       ├── product-batches.ts    # Batch stok & FEFO
│   │       ├── suppliers.ts          # Distributor PBF
│   │       ├── purchase-invoices.ts  # Faktur pembelian
│   │       ├── purchase-items.ts     # Detail item faktur
│   │       ├── purchase-orders.ts    # Surat pesanan
│   │       ├── purchase-payments.ts  # Pembayaran hutang
│   │       ├── transactions.ts       # Transaksi kasir POS
│   │       ├── transaction-items.ts  # Detail item terjual
│   │       ├── customers.ts          # Database pasien
│   │       ├── shift-sessions.ts     # Shift kasir
│   │       ├── expenses.ts           # Beban operasional
│   │       ├── promotions.ts         # Promo & diskon
│   │       ├── stock-mutations.ts    # Mutasi stok
│   │       ├── stock-opnames.ts      # Stock opname
│   │       └── phase3.ts             # Schema fase 3
│   ├── middleware/
│   │   ├── auth.ts                   # JWT verification
│   │   └── tenant.ts                 # Tenant ID resolver
│   ├── routes/                       # 21 API route modules
│   │   ├── auth.routes.ts            # Login, register, profile
│   │   ├── dashboard.routes.ts       # KPI & statistik
│   │   ├── products.routes.ts        # CRUD produk & satuan
│   │   ├── inventory.routes.ts       # Stok batch & FEFO
│   │   ├── transactions.routes.ts    # Checkout POS
│   │   ├── purchases.routes.ts       # Faktur & SP PBF
│   │   ├── suppliers.routes.ts       # Distributor PBF
│   │   ├── customers.routes.ts       # Pasien & PMR
│   │   ├── reports.routes.ts         # Laporan penjualan
│   │   ├── accounting.routes.ts      # P&L & Pareto
│   │   ├── expenses.routes.ts        # Beban operasional
│   │   ├── ai.routes.ts              # Gemini AI chat & interaksi
│   │   ├── satusehat.routes.ts       # FHIR Kemenkes
│   │   ├── defecta.routes.ts         # Buku defecta
│   │   ├── transfers.routes.ts       # Transfer stok
│   │   ├── promotions.routes.ts      # Promo & diskon
│   │   ├── reminders.routes.ts       # Pengingat pasien
│   │   ├── billing.routes.ts         # Langganan SaaS
│   │   ├── outlets.routes.ts         # Manajemen cabang
│   │   ├── users.routes.ts           # Manajemen user
│   │   └── whatsapp.routes.ts        # WhatsApp API
│   ├── lib/
│   │   └── utils.ts                  # Shared utilities
│   └── types/
│       └── index.ts                  # TypeScript interfaces
├── drizzle.config.ts                 # Drizzle Kit configuration
├── .env.example                      # Environment template
├── package.json
└── tsconfig.json
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** ≥ 18.x
- **PostgreSQL** 14+ (running on port 5432)
- **Google Gemini API Key** (untuk fitur AI)

### Installation

```bash
# 1. Clone repository
git clone https://github.com/Salman-artz/SaasApotek_API.git
cd SaasApotek_API

# 2. Install dependencies
npm install

# 3. Setup environment variables
cp .env.example .env
```

Edit `.env`:
```env
DATABASE_URL=postgres://postgres:your_password@localhost:5432/apotek_digital_db
JWT_SECRET=change_this_to_a_secure_random_key_min_32_chars_long
PORT=3001
NODE_ENV=development
GEMINI_API_KEY=your_gemini_pro_api_key_here
```

### Database Setup

```bash
# Buat database PostgreSQL
psql -U postgres -c "CREATE DATABASE apotek_digital_db;"

# Generate migration files
npm run db:generate

# Push schema ke database
npm run db:push

# (Opsional) Buka Drizzle Studio
npm run db:studio
```

### Development

```bash
# Jalankan dev server dengan hot reload
npm run dev

# Server berjalan di http://localhost:3001
```

### Build Production

```bash
npm run build
npm start
```

---

## 📡 API Endpoints

### Authentication
| Method | Endpoint | Keterangan |
|--------|----------|-----------|
| `POST` | `/api/auth/register` | Registrasi tenant & user baru |
| `POST` | `/api/auth/login` | Login & mendapatkan JWT token |
| `GET` | `/api/auth/me` | Profil user saat ini |

### Products & Inventory
| Method | Endpoint | Keterangan |
|--------|----------|-----------|
| `GET` | `/api/products` | Daftar semua produk obat |
| `POST` | `/api/products` | Tambah produk baru |
| `GET` | `/api/inventory/batches` | Stok per batch (FEFO) |
| `GET` | `/api/inventory/expiry-radar` | Radar obat mendekati kadaluarsa |

### Transactions (POS)
| Method | Endpoint | Keterangan |
|--------|----------|-----------|
| `POST` | `/api/transactions/checkout` | Proses checkout kasir |
| `GET` | `/api/transactions` | Riwayat transaksi |

### Reports & Accounting
| Method | Endpoint | Keterangan |
|--------|----------|-----------|
| `GET` | `/api/reports/daily-trend` | Tren omset harian |
| `GET` | `/api/accounting/profit-and-loss` | Laporan laba rugi |
| `GET` | `/api/accounting/pareto` | Analisis Pareto ABC |

### AI (Gemini)
| Method | Endpoint | Keterangan |
|--------|----------|-----------|
| `POST` | `/api/ai/ask` | Chat AI farmakologi |
| `POST` | `/api/ai/check-interaction` | Cek interaksi obat |
| `GET` | `/api/ai/restock-insights` | Rekomendasi smart restock |

### Health Check
| Method | Endpoint | Keterangan |
|--------|----------|-----------|
| `GET` | `/health` | Status kesehatan server |

---

## 📄 Available Scripts

| Script | Keterangan |
|--------|-----------|
| `npm run dev` | Development server (tsx watch) |
| `npm run build` | Build production (tsup) |
| `npm start` | Jalankan production build |
| `npm run db:generate` | Generate Drizzle migration |
| `npm run db:migrate` | Jalankan migrasi database |
| `npm run db:push` | Push schema langsung ke DB |
| `npm run db:studio` | Buka Drizzle Studio GUI |

---

## 📝 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

<p align="center">
  <sub>Built with ❤️ using Hono.js, TypeScript, Drizzle ORM & PostgreSQL</sub>
</p>
