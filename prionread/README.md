# 📚 PrionRead

Sistema de gestión de lectura crítica de literatura científica para laboratorios de doctorado.

## 🎯 Características

- **Repositorio estructurado** de artículos científicos con metadatos automáticos (DOI/PubMed)
- **Dashboard personalizado** para estudiantes con estadísticas y progreso
- **Resúmenes asistidos por IA** utilizando GPT-4
- **Autoevaluaciones** tipo test con puntuación automática
- **Sistema de valoraciones** colaborativo
- **Motor de recomendaciones inteligente** que balancea temas y prioridades
- **Notificaciones automáticas** por email
- **Panel de administración** completo con métricas y reportes
- **Almacenamiento en Dropbox** para PDFs
- **PrionBonus** — sistema de créditos de tiempo quid-pro-quo

## 🏗️ Arquitectura

- **Backend**: Node.js + Express + PostgreSQL + Sequelize
- **Frontend**: React + Vite + TailwindCSS + React Router
- **Almacenamiento**: Dropbox API
- **IA**: OpenAI API (GPT-4o-mini)
- **Emails**: Nodemailer (SMTP)
- **Tareas programadas**: node-cron

## 📋 Prerequisitos

- Node.js 18+
- PostgreSQL 14+
- Cuenta de Dropbox con API configurada
- Cuenta de OpenAI (opcional, para resúmenes con IA)
- Servidor SMTP (Gmail, SendGrid, etc.)

## 🚀 Instalación

### 1. Clonar repositorio

```bash
git clone https://github.com/Jokin1969/PrionLab-tools.git
cd PrionLab-tools/prionread
```

### 2. Backend

```bash
cd backend
npm install
```

Crea archivo `.env` basándote en `.env.example`:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/prionread
JWT_SECRET=tu-secreto-super-seguro-aqui

DROPBOX_APP_KEY=tu-app-key
DROPBOX_APP_SECRET=tu-app-secret
DROPBOX_REFRESH_TOKEN=tu-refresh-token

OPENAI_API_KEY=sk-...

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=tu-email@gmail.com
SMTP_PASS=tu-app-password

FRONTEND_URL=http://localhost:3000
PORT=5000

ENABLE_CRON=false
NODE_ENV=development
```

Sincroniza la base de datos:

```bash
npm run db:sync
```

Crea el primer administrador:

```bash
npm run init
```

Inicia el servidor:

```bash
npm run dev
```

### 3. Frontend

```bash
cd ../frontend
npm install
```

Crea archivo `.env`:

```env
VITE_API_URL=http://localhost:5000/api
```

Inicia el servidor de desarrollo:

```bash
npm run dev
```

La aplicación estará disponible en http://localhost:3000

## 👤 Primer Usuario Admin

Usa el script interactivo incluido:

```bash
cd backend
npm run init
```

O inserta manualmente en PostgreSQL:

```sql
INSERT INTO users (id, name, email, password, role, created_at, updated_at)
VALUES (
  gen_random_uuid(),
  'Admin',
  'admin@lab.com',
  '$2b$10$...', -- Hash de la contraseña con bcrypt
  'admin',
  NOW(),
  NOW()
);
```

## 📚 Uso

### Estudiantes

1. Reciben email de bienvenida con credenciales
2. Cambian contraseña en primer login
3. Acceden a su dashboard personalizado
4. Leen artículos, crean resúmenes y realizan evaluaciones
5. Valoran artículos y ven recomendaciones
6. Acumulan minutos de PrionBonus al completar cada artículo

### Administradores

1. Gestionan usuarios (crear, editar, eliminar)
2. Añaden artículos (manual o por DOI/PubMed)
3. Asignan artículos a estudiantes
4. Consultan métricas y exportan reportes
5. Envían recordatorios personalizados
6. Gestionan el sistema PrionBonus (asignar tiempo, ver balances)

## ⚡ PrionBonus

Sistema de créditos de tiempo quid-pro-quo que incentiva la lectura activa.

### Cómo funciona

- **Estudiantes ganan minutos** al completar un artículo (resumen + evaluación + valoración).
  La fórmula es: `páginas_del_PDF × 5 minutos` (por defecto 10 páginas = 50 min si no hay PDF).
- **Jokin asigna su tiempo** a tareas de tutoría (reuniones, correcciones, revisiones, etc.)
  descontando minutos del balance de cada estudiante.
- El **balance neto** (créditos ganados − tiempo asignado) refleja la deuda mutua en tiempo.
- Si el balance cae por debajo de **−120 minutos**, el sistema muestra avisos de deuda.

### Notificaciones

Cada vez que un estudiante completa un artículo y gana créditos, recibe un email con:
- Los minutos ganados en ese artículo
- El título del artículo
- Su balance total actualizado

### Panel de administración (`/admin/bonus`)

- Vista de todos los estudiantes ordenada por balance (más endeudados primero)
- Modal para añadir asignaciones de tiempo con tipos predefinidos:
  - Reunión de tutoría
  - Corrección de manuscrito
  - Revisión de datos / análisis
  - Otro
- Presets rápidos: 30 / 60 / 90 / 120 min

### Vista del estudiante (`/bonus`)

- Balance actual con código de color (verde/ámbar/rojo)
- Historial completo de créditos ganados y tiempo asignado
- Widget resumen en el dashboard principal

### Tablas de base de datos

| Tabla | Descripción |
|---|---|
| `bonus_credits` | Un registro por artículo completado (idempotente, único por `user_id + article_id`) |
| `bonus_allocations` | Asignaciones de tiempo de Jokin hacia cada estudiante |

### Constantes configurables (en `bonusController.js`)

```js
const MINUTES_PER_PAGE = 5;   // minutos ganados por página de PDF
const DEFAULT_PAGES    = 10;  // páginas por defecto si el PDF no tiene metadato
const DEBT_THRESHOLD   = -120; // minutos de deuda máxima antes de avisos
```

## 🔧 Scripts Útiles

### Backend

```bash
npm run dev                    # Desarrollo
npm run init                   # Crear primer administrador
npm run db:sync                # Sincronizar modelos con DB
npm run test:recommendations   # Probar motor de recomendaciones
npm run test:notifications     # Probar sistema de notificaciones
```

### Frontend

```bash
npm run dev                    # Desarrollo
npm run build                  # Build producción
npm run preview                # Preview build
```

## 🚀 Deployment

### Backend (Railway)

1. Crear nuevo proyecto en Railway
2. Conectar repositorio GitHub
3. Configurar variables de entorno (ver `.env.example`)
4. Railway detectará automáticamente Node.js
5. Build command: `cd prionread/backend && npm install`
6. Start command: `cd prionread/backend && npm start`

### Frontend (Vercel/Netlify)

1. Crear nuevo proyecto
2. Root directory: `prionread/frontend`
3. Build command: `npm run build`
4. Output directory: `dist`
5. Configurar variable `VITE_API_URL` con URL del backend

## 📖 Documentación API

Ver [docs/API.md](./docs/API.md) para documentación completa de endpoints.

## 🤝 Contribuir

1. Fork el proyecto
2. Crea una rama (`git checkout -b feature/amazing-feature`)
3. Commit cambios (`git commit -m 'Add amazing feature'`)
4. Push a la rama (`git push origin feature/amazing-feature`)
5. Abre un Pull Request

## 📝 Licencia

MIT

## 👥 Autores

- **PrionLab Team** - Desarrollo inicial

## 🙏 Agradecimientos

- Comunidad de neurociencias por el feedback
- Todos los doctorandos que utilizan el sistema
