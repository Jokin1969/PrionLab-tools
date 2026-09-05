# 📡 PrionRead API Documentation

Base URL: `/api`

## Autenticación

Todos los endpoints (excepto login) requieren token JWT en header:

```
Authorization: Bearer <token>
```

---

## Auth

### POST `/auth/login`

Iniciar sesión.

**Body:**
```json
{ "email": "user@lab.com", "password": "secret" }
```

**Response 200:**
```json
{
  "token": "<jwt>",
  "user": { "id": "uuid", "name": "Ana", "email": "ana@lab.com", "role": "student" }
}
```

---

### POST `/auth/register` _(admin only)_

Crear nuevo usuario. Envía email de bienvenida con contraseña temporal.

**Body:**
```json
{ "name": "Ana García", "email": "ana@lab.com", "role": "student" }
```

**Response 201:**
```json
{ "user": { "id": "uuid", "name": "Ana García", "email": "ana@lab.com", "role": "student" } }
```

---

### POST `/auth/change-password`

Cambiar contraseña del usuario autenticado.

**Body:**
```json
{ "currentPassword": "old", "newPassword": "new" }
```

---

### GET `/auth/me`

Obtener datos del usuario autenticado.

**Response 200:**
```json
{ "id": "uuid", "name": "Ana", "email": "ana@lab.com", "role": "student" }
```

---

## Estudiantes

### GET `/my-dashboard`

Dashboard personalizado con estadísticas, progreso y recomendaciones.

**Response 200:**
```json
{
  "stats": {
    "total_assigned": 20,
    "pending": 10,
    "read": 3,
    "summarized": 4,
    "evaluated": 3,
    "avg_score": 7.5,
    "streak": 3,
    "total_hours_estimated": 60
  },
  "recent_activity": [
    { "type": "evaluated", "article_id": "uuid", "article_title": "...", "score": 8, "date": "2024-01-15" }
  ],
  "next_recommended": [ { "id": "uuid", "title": "...", "recommendation_score": 62.5 } ],
  "progress_by_month": [ { "month": "2024-01", "read": 2, "summarized": 1, "evaluated": 1 } ],
  "lab_comparison": { "rank": 2, "total_students": 5, "percentile": 75, "avg_lab_completion_rate": 45 }
}
```

---

### GET `/my-articles`

Listar artículos asignados al estudiante. Soporta filtros por query string.

**Query params:** `status`, `search`, `priority`, `is_milestone`, `page`, `limit`

**Response 200:**
```json
{
  "articles": [ { "id": "uuid", "title": "...", "status": "pending", ... } ],
  "total": 20,
  "page": 1,
  "totalPages": 2
}
```

---

### GET `/my-articles/:id`

Detalle de un artículo asignado.

---

### POST `/my-articles/:id/read`

Marcar artículo como leído.

---

### GET `/my-articles/:id/summary`

Obtener resumen del estudiante para un artículo.

---

### POST `/my-articles/:id/summary`

Crear o actualizar resumen.

**Body:**
```json
{ "content": "El artículo presenta..." }
```

---

### POST `/summary/ai`

Generar resumen con IA (GPT-4o-mini).

**Body:**
```json
{ "userArticleId": "uuid" }
```

---

### POST `/my-articles/:id/generate-evaluation`

Generar test de comprensión con IA para un artículo.

---

### GET `/my-articles/:id/evaluation`

Obtener evaluación existente.

---

### POST `/my-articles/:id/submit-evaluation`

Enviar respuestas de evaluación.

**Body:**
```json
{ "answers": { "0": "b", "1": "a" } }
```

**Response 200:**
```json
{ "score": 8, "passed": true, "correct": 8, "total": 10 }
```

---

### GET `/articles/:id/ratings`

Obtener valoraciones de un artículo.

---

### POST `/articles/:id/ratings`

Valorar un artículo (1-5 estrellas).

**Body:**
```json
{ "rating": 4, "comment": "Muy interesante" }
```

---

## Admin — Usuarios

### GET `/users`

Listar todos los usuarios. _(admin only)_

**Query params:** `role`, `search`

---

### GET `/users/:id`

Detalle de un usuario. _(admin only)_

---

### PUT `/users/:id`

Actualizar usuario. _(admin only)_

**Body:** `{ "name": "...", "email": "...", "role": "..." }`

---

### DELETE `/users/:id`

Eliminar usuario. _(admin only)_

---

### POST `/users/bulk`

Crear múltiples usuarios a la vez. _(admin only)_

**Body:** `{ "users": [ { "name": "...", "email": "..." } ] }`

---

### POST `/admin/users/:userId/reset-password`

Resetear contraseña de un usuario. Envía email con nueva contraseña temporal. _(admin only)_

---

### POST `/admin/users/:userId/send-reminder`

Enviar recordatorio personalizado a un estudiante. _(admin only)_

**Body:** `{ "message": "..." }` _(opcional — si se omite se envía recordatorio estándar)_

---

## Admin — Artículos

### GET `/articles`

Listar artículos. _(admin only para ver todos)_

**Query params:** `search`, `priority`, `is_milestone`, `tags`, `page`, `limit`

---

### POST `/articles`

Crear artículo. Acepta `multipart/form-data` para subir PDF.

**Fields:** `title`, `authors`, `year`, `journal`, `doi`, `pubmed_id`, `abstract`, `priority`, `is_milestone`, `tags`, `pdf` _(file)_

---

### GET `/articles/fetch-metadata`

Obtener metadatos automáticos desde DOI o PubMed.

**Query params:** `doi` o `pubmed_id`

**Response 200:**
```json
{ "title": "...", "authors": ["..."], "year": 2023, "journal": "...", "abstract": "..." }
```

---

### PUT `/articles/:id`

Actualizar artículo. _(admin only)_

---

### DELETE `/articles/:id`

Eliminar artículo. _(admin only)_

---

### POST `/articles/:id/assign`

Asignar artículo a usuarios específicos. _(admin only)_

**Body:** `{ "userIds": ["uuid1", "uuid2"] }`

---

### POST `/articles/:id/assign-all` · `/admin/articles/:id/assign-to-all`

Asignar artículo a todos los estudiantes. _(admin only)_

---

### POST `/articles/bulk-assign`

Asignación masiva. _(admin only)_

**Body:** `{ "articleIds": [...], "userIds": [...] }`

---

## Admin — Dashboard y Reportes

### GET `/admin/dashboard`

Métricas globales del laboratorio.

**Response 200:**
```json
{
  "totalUsers": 10,
  "totalArticles": 50,
  "totalEvaluations": 120,
  "avgScore": 7.8,
  "progressByMonth": [...],
  "topArticles": [...]
}
```

---

### GET `/admin/users/:userId/detailed-stats`

Estadísticas detalladas de un estudiante. _(admin only)_

---

### GET `/admin/users/export`

Exportar datos de usuarios en CSV. _(admin only)_

---

### GET `/admin/articles/analytics`

Analíticas de artículos (engagement, scores medios, etc.). _(admin only)_

---

### GET `/admin/articles/:articleId/engagement`

Métricas de engagement de un artículo específico. _(admin only)_

---

### GET `/admin/reports/recommendations`

Recomendaciones para todos los estudiantes. _(admin only)_

---

### GET `/admin/reports/export-pdf`

Exportar reporte completo en PDF. _(admin only)_

---

## Admin — Notificaciones

### POST `/admin/notifications/weekly-reminders`

Enviar recordatorios semanales a todos los estudiantes con artículos pendientes. _(admin only)_

**Response 200:**
```json
{ "ok": true, "sent": 8, "skipped": 2, "errors": 0 }
```

---

### POST `/admin/notifications/inactivity-reminders`

Enviar recordatorios a estudiantes inactivos (sin actividad en ≥14 días). _(admin only)_

**Response 200:**
```json
{ "ok": true, "sent": 3, "skipped": 7, "errors": 0 }
```

---

## Códigos de error comunes

| Código | Descripción |
|--------|-------------|
| 400 | Bad Request — parámetros inválidos |
| 401 | Unauthorized — token ausente o expirado |
| 403 | Forbidden — rol insuficiente |
| 404 | Not Found — recurso no encontrado |
| 409 | Conflict — duplicado (ej. email ya registrado) |
| 500 | Internal Server Error |
