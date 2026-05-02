# PrionRead

PrionRead is a web application for managing critical reading of scientific literature in a doctoral research laboratory.

## Features

- **Article repository** — centralized storage of papers with metadata, tags, and Dropbox PDF integration
- **Reading progress tracking** — per-student status: pending → read → summarized → evaluated
- **Summaries** — students write structured summaries; AI-assisted generation available
- **Evaluations** — auto-generated comprehension tests with scoring
- **Ratings** — lab members rate and comment on articles
- **Admin dashboard** — manage users, assign reading lists, monitor progress

## Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js, Express, Sequelize ORM |
| Database | PostgreSQL (Railway) |
| Frontend | React 18, Vite, TailwindCSS |
| Auth | JWT |
| Storage | Dropbox SDK |
| Email | Nodemailer |

## Project structure

```
prionread/
├── backend/      # Express API
└── frontend/     # React + Vite SPA
```

## Getting started

### Backend

```bash
cd backend
cp .env.example .env   # fill in your values
npm install
npm run db:sync        # create tables
npm run dev
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

## Environment variables

See `backend/.env.example` for the full list of required variables.
