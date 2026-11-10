# AutoProcess

**AI-Powered Document Extraction + Workflow Automation Platform**

A clean, modern MVP inspired by Exlify.AI — combining structured forms, intelligent document processing (Gemini), and visual workflows.

## Stack

- **Frontend**: React 19 + Vite + TypeScript + beautiful custom CSS (dark elegant theme)
- **Backend**: Node.js + Express + TypeScript
- **Database**: PostgreSQL + Prisma
- **AI**: Google Gemini (gemini-1.5-flash)

## Project Structure

```
autoprocess/
├── backend/
│   ├── prisma/schema.prisma
│   ├── src/
│   │   ├── index.ts
│   │   ├── middleware/ (auth, errorHandler)
│   │   ├── routes/ (auth, forms, workflows, jobs, documents)
│   │   └── services/gemini.ts
│   ├── uploads/
│   ├── .env
│   └── package.json
└── frontend/
    └── (Vite React app)
```

## Quick Start

### 1. Database (already set up in this environment)

PostgreSQL is running with:

- User: `autoprocess`
- Password: `autoprocess123`
- Database: `autoprocess`
- Connection: `postgresql://autoprocess:autoprocess123@localhost:5432/autoprocess`

### 2. Backend

```bash
cd backend
npm install
npx prisma generate
npx prisma migrate dev --name init
# Put your real Gemini key in .env
# GEMINI_API_KEY=your_real_key
npm run dev
```

API will be at http://localhost:4000

### 3. Frontend

```bash
cd frontend
npm install
npm install react-router-dom axios lucide-react
# (add Tailwind or use the custom CSS already prepared)
npm run dev
```

### Environment Variables (backend/.env)

```
DATABASE_URL="postgresql://autoprocess:autoprocess123@localhost:5432/autoprocess?schema=public"
JWT_SECRET="autoprocess-super-secret-jwt-key-change-in-production-2026"
PORT=4000
GEMINI_API_KEY="YOUR_GEMINI_API_KEY_HERE"
UPLOAD_DIR="./uploads"
```

## Core Features Implemented

### Backend (ready)
- [x] Auth (register / login / JWT)
- [x] Workspaces (auto-created on register)
- [x] Forms CRUD (JSON Schema based)
- [x] Workflows CRUD (stores React Flow definition)
- [x] Document upload + Gemini AI extraction
- [x] Jobs tracking with status + results
- [x] Extraction results with confidence

### Frontend (scaffolded – next steps)
- Login / Register screens
- Dashboard
- Form Builder
- Document Upload + Extraction UI
- Workflow Designer (React Flow)
- Jobs / Results list

## API Overview

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/register | Create account + default workspace |
| POST | /api/auth/login | Login |
| GET  | /api/auth/me | Current user + workspaces |
| GET/POST/PUT/DELETE | /api/forms | Form management |
| GET/POST/PUT/DELETE | /api/workflows | Workflow management |
| POST | /api/documents/extract | Upload file + extract with Gemini |
| GET  | /api/jobs | List jobs / results |

## Next Development Steps

1. Finish frontend pages with the beautiful dark theme already started
2. Integrate React Flow for visual workflow designer
3. Add form builder UI (drag fields or JSON schema editor)
4. Human-in-the-loop review for low-confidence extractions
5. Webhook / integration nodes

---

Built as a full MVP clone of the Exlify core platform.



christinasharanyaa11a_db_user

gqa53LN9gxGiLt2w