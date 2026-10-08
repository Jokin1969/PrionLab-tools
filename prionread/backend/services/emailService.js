const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

transporter.verify((error) => {
  if (error) {
    console.error('❌ Error en configuración SMTP:', error.message);
  } else {
    console.log('✅ Servidor SMTP listo');
  }
});

// FRONTEND_URL must be set in Railway env vars to the Flask host:
//   FRONTEND_URL=https://web-production-5517e.up.railway.app
// PRIONREAD_BASE is the sub-path (default /prionread). Together they form
// the absolute base URL used in all email links.

const firstName = (name) => (name || '').trim().split(/\s+/)[0];
const FRONTEND_URL = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
const PRIONREAD_BASE = (process.env.PRIONREAD_BASE || '/prionread').replace(/\/$/, '');
const APP_URL = `${FRONTEND_URL}${PRIONREAD_BASE}`;

if (!FRONTEND_URL) {
  console.error(
    '❌ FRONTEND_URL is not set. Email links will be relative (broken).\n' +
    '   Set FRONTEND_URL=https://web-production-5517e.up.railway.app in Railway env vars.'
  );
} else if (!APP_URL.startsWith('http')) {
  console.error(`❌ APP_URL does not look absolute: "${APP_URL}". Check FRONTEND_URL.`);
} else {
  console.log(`✅ Email links will use: ${APP_URL}`);
}

const base = (content) => `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
    ${content}
    <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;">
    <p style="color: #6b7280; font-size: 12px; text-align: center;">
      PrionRead – Sistema de Gestión de Lectura Científica
    </p>
  </div>
`;

const stepHtml = (n, text) => `
  <table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
    <tr>
      <td style="width:36px;vertical-align:top;">
        <div style="background:#4F46E5;color:white;width:28px;height:28px;border-radius:50%;text-align:center;line-height:28px;font-weight:bold;font-size:13px;">${n}</div>
      </td>
      <td style="vertical-align:top;padding-left:10px;color:#374151;font-size:14px;padding-top:4px;">${text}</td>
    </tr>
  </table>
`;

// Builds the onboarding email HTML — shared by sendOnboardingEmail and the preview endpoint
function buildOnboardingHtml(user, tempPassword) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111827;">

      <!-- Header -->
      <div style="background:#4F46E5;padding:32px 24px;text-align:center;border-radius:12px 12px 0 0;">
        <p style="color:rgba(255,255,255,0.85);font-size:12px;margin:0 0 8px;letter-spacing:2px;text-transform:uppercase;">Laboratorio de Investigación</p>
        <h1 style="color:#ffffff;margin:0;font-size:26px;">📚 Bienvenid@ a PrionRead</h1>
        <p style="color:rgba(255,255,255,0.8);margin:8px 0 0;font-size:14px;">Tu plataforma de lectura científica</p>
      </div>

      <!-- Body -->
      <div style="background:#ffffff;padding:32px 24px;border:1px solid #e5e7eb;border-top:none;">

        <p style="font-size:16px;margin-top:0;">Hola <strong>${firstName(user.name)}</strong>,</p>
        <p style="color:#374151;line-height:1.6;">Tu cuenta en PrionRead está lista. Aquí tienes todo lo que necesitas para empezar.</p>

        <!-- Credentials -->
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-left:4px solid #4F46E5;padding:20px;border-radius:0 8px 8px 0;margin:24px 0;">
          <h3 style="margin:0 0 12px;color:#4F46E5;font-size:14px;letter-spacing:1px;">🔑 TUS CREDENCIALES DE ACCESO</h3>
          <p style="margin:6px 0;color:#374151;"><strong>Email:</strong> ${user.email}</p>
          <p style="margin:6px 0 8px;color:#374151;"><strong>Contraseña temporal:</strong></p>
          <div style="background:#fff;border:2px dashed #4F46E5;padding:12px 16px;border-radius:6px;text-align:center;">
            <code style="font-size:22px;letter-spacing:4px;color:#1e1b4b;font-weight:bold;">${tempPassword}</code>
          </div>
          <p style="margin:10px 0 0;color:#6b7280;font-size:12px;">⚠️ Cambia esta contraseña en tu perfil después de tu primer acceso.</p>
        </div>

        <!-- Why PrionRead -->
        <div style="background:#faf5ff;border-left:4px solid #7C3AED;padding:20px;border-radius:0 8px 8px 0;margin:24px 0;">
          <h3 style="margin:0 0 14px;color:#7C3AED;font-size:14px;letter-spacing:1px;">💡 POR QUÉ EXISTE PRIONREAD</h3>
          <ol style="margin:0;padding-left:18px;color:#374151;line-height:1.9;font-size:14px;">
            <li style="margin-bottom:8px;">PrionRead convierte la lectura científica en un hábito estructurado con artículos ya seleccionados para ti — no pierdes tiempo buscando qué leer.</li>
            <li style="margin-bottom:8px;">Leer, resumir y autoevaluarte no es una obligación: es construir la <strong>munición intelectual</strong> que alimenta tu creatividad científica futura.</li>
            <li style="margin-bottom:8px;">No hay ideas nuevas sin conocimiento previo — los papers de PrionRead son la materia prima de tus futuros descubrimientos.</li>
            <li style="margin-bottom:8px;">Tu supervisor verá tu progreso: no para vigilar, sino para <strong>acompañarte</strong> y animarte cuando te estanques.</li>
            <li>El compromiso es real (2–3 artículos/semana), pero es la inversión que más fruto da: base sólida, criterio lector y confianza científica para toda tu carrera.</li>
          </ol>
        </div>

        <!-- Mini-guide -->
        <div style="background:#f0fdf4;border-left:4px solid #10B981;padding:20px;border-radius:0 8px 8px 0;margin:24px 0;">
          <h3 style="margin:0 0 16px;color:#047857;font-size:14px;letter-spacing:1px;">🚀 CÓMO EMPEZAR — 5 PASOS</h3>
          ${stepHtml(1, 'Entra con tu email y contraseña temporal → <strong>cámbiala en tu perfil</strong> nada más acceder.')}
          ${stepHtml(2, 'En <strong>Mis Artículos</strong> verás los que tienes asignados — empieza por los <span style="background:#FEF3C7;color:#92400E;padding:2px 5px;border-radius:3px;font-size:12px;">⭐ Milestones</span>, son los cimientos del campo.')}
          ${stepHtml(3, 'Lee el PDF completo → escribe tu <strong>resumen</strong>. Hay asistencia de IA disponible, pero úsala <em>después</em> de leer, no antes.')}
          ${stepHtml(4, 'Realiza la <strong>autoevaluación</strong> del artículo para consolidar lo aprendido. Es el gimnasio de tu comprensión científica.')}
          ${stepHtml(5, 'Consulta tu <strong>Dashboard</strong> para ver tu progreso, logros y recomendaciones personalizadas según tus gaps de conocimiento.')}
        </div>

        <!-- CTA -->
        <div style="text-align:center;margin:32px 0 16px;">
          <a href="${APP_URL}/login"
             style="display:inline-block;background:#4F46E5;color:white;padding:14px 36px;
                    text-decoration:none;border-radius:8px;font-weight:bold;font-size:16px;">
            Entrar en PrionRead →
          </a>
        </div>

        <p style="color:#6b7280;font-size:13px;text-align:center;margin-top:8px;">
          ¿Dudas o sugerencias? Escríbeme directamente o usa los comentarios dentro de la app.
        </p>

      </div>

      <!-- Footer -->
      <div style="background:#f9fafb;padding:16px 24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;text-align:center;">
        <p style="color:#9ca3af;font-size:12px;margin:0;">PrionRead – Sistema de Gestión de Lectura Científica</p>
      </div>

    </div>
  `;
}

const emailService = {
  buildOnboardingHtml,

  sendWelcomeEmail: async (user, tempPassword) => {
    await transporter.sendMail({
      from: `"PrionRead" <${process.env.SMTP_USER}>`,
      to: user.email,
      subject: '🎓 Bienvenido a PrionRead',
      html: base(`
        <h1 style="color: #4F46E5;">¡Bienvenido a PrionRead!</h1>
        <p>Hola ${firstName(user.name)},</p>
        <p>Tu cuenta ha sido creada. Aquí están tus credenciales de acceso:</p>
        <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Email:</strong> ${user.email}</p>
          <p><strong>Contraseña temporal:</strong>
            <code style="background-color: #fff; padding: 5px 10px; border-radius: 4px;">${tempPassword}</code>
          </p>
        </div>
        <p>⚠️ Por favor, <strong>cambia tu contraseña</strong> después de tu primer inicio de sesión.</p>
        <p>
          <a href="${APP_URL}/login"
             style="display: inline-block; background-color: #4F46E5; color: white; padding: 12px 24px;
                    text-decoration: none; border-radius: 6px; margin-top: 20px;">
            Iniciar Sesión
          </a>
        </p>
      `),
    });
    console.log(`✉️  Bienvenida enviada a ${user.email}`);
  },

  sendOnboardingEmail: async (user, tempPassword) => {
    await transporter.sendMail({
      from: `"PrionRead" <${process.env.SMTP_USER}>`,
      to: user.email,
      subject: '📚 Bienvenid@ a PrionRead — Tus credenciales y guía de inicio',
      html: buildOnboardingHtml(user, tempPassword),
    });
    console.log(`✉️  Onboarding enviado a ${user.email}`);
  },

  sendPasswordResetEmail: async (user, tempPassword) => {
    await transporter.sendMail({
      from: `"PrionRead" <${process.env.SMTP_USER}>`,
      to: user.email,
      subject: '🔑 Tu contraseña ha sido reseteada',
      html: base(`
        <h1 style="color: #4F46E5;">Contraseña Reseteada</h1>
        <p>Hola ${firstName(user.name)},</p>
        <p>Tu contraseña ha sido reseteada por el administrador.</p>
        <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <p><strong>Nueva contraseña temporal:</strong></p>
          <code style="background-color: #fff; padding: 10px 15px; border-radius: 4px;
                       font-size: 18px; display: inline-block;">${tempPassword}</code>
        </div>
        <p>⚠️ Por favor, cambia esta contraseña lo antes posible desde tu perfil.</p>
        <p>
          <a href="${APP_URL}/login"
             style="display: inline-block; background-color: #4F46E5; color: white; padding: 12px 24px;
                    text-decoration: none; border-radius: 6px; margin-top: 20px;">
            Iniciar Sesión
          </a>
        </p>
      `),
    });
    console.log(`✉️  Reset de contraseña enviado a ${user.email}`);
  },

  sendReminderEmail: async (user, stats, nextArticles) => {
    const completionPct = stats.total_assigned
      ? ((stats.evaluated / stats.total_assigned) * 100).toFixed(0)
      : 0;

    const articleItems = (nextArticles || []).slice(0, 5).map((a, idx) => `
      <li style="background-color: #f9fafb; padding: 15px; margin: 10px 0; border-radius: 6px;
                 border-left: 3px solid ${a.is_milestone ? '#F59E0B' : '#4F46E5'};">
        <strong style="color: #111827;">${idx + 1}. ${a.title}</strong><br>
        <span style="color: #6b7280; font-size: 14px;">
          ${Array.isArray(a.authors) ? a.authors.slice(0, 2).join(', ') : a.authors || ''} (${a.year || ''})
        </span>
        ${a.is_milestone ? '<br><span style="background-color: #FEF3C7; color: #92400E; padding: 2px 8px; border-radius: 3px; font-size: 12px;">⭐ Milestone</span>' : ''}
      </li>
    `).join('');

    await transporter.sendMail({
      from: `"PrionRead" <${process.env.SMTP_USER}>`,
      to: user.email,
      subject: '📚 PrionRead: Tu resumen semanal',
      html: base(`
        <h1 style="color: #4F46E5;">📚 Tu Resumen Semanal</h1>
        <p>Hola ${firstName(user.name)},</p>
        <div style="background-color: #f0fdf4; border-left: 4px solid #10B981; padding: 15px; margin: 20px 0;">
          <h3 style="margin-top: 0; color: #047857;">Tu Progreso</h3>
          <p style="margin: 5px 0;">✅ Artículos evaluados: <strong>${stats.evaluated || 0}</strong></p>
          <p style="margin: 5px 0;">📊 Puntuación media: <strong>${stats.avg_score != null ? Number(stats.avg_score).toFixed(1) : '—'}/10</strong></p>
          <p style="margin: 5px 0;">📈 Completitud: <strong>${completionPct}%</strong></p>
        </div>
        ${nextArticles?.length ? `
          <h3 style="color: #4F46E5;">🎯 Próximas Lecturas Recomendadas</h3>
          <ul style="list-style: none; padding: 0;">${articleItems}</ul>
        ` : ''}
        <p>
          <a href="${APP_URL}/my-articles"
             style="display: inline-block; background-color: #10B981; color: white; padding: 12px 24px;
                    text-decoration: none; border-radius: 6px; margin-top: 20px;">
            Ver Mis Artículos
          </a>
        </p>
      `),
    });
    console.log(`✉️  Recordatorio enviado a ${user.email}`);
  },

  sendCustomEmail: async (user, message) => {
    await transporter.sendMail({
      from: `"PrionRead Admin" <${process.env.SMTP_USER}>`,
      to: user.email,
      subject: '📬 Mensaje del Administrador – PrionRead',
      html: base(`
        <h1 style="color: #4F46E5;">Mensaje del Administrador</h1>
        <p>Hola ${firstName(user.name)},</p>
        <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
          ${message.replace(/\n/g, '<br>')}
        </div>
        <p>
          <a href="${APP_URL}/dashboard"
             style="display: inline-block; background-color: #4F46E5; color: white; padding: 12px 24px;
                    text-decoration: none; border-radius: 6px; margin-top: 20px;">
            Ir a PrionRead
          </a>
        </p>
      `),
    });
    console.log(`✉️  Email personalizado enviado a ${user.email}`);
  },

  // ─── PrionBonus intro email (welcome gift) ───────────────────────────────

  buildBonusIntroHtml: (user, bonusMinutes = 200) => {
    const first = firstName(user.name);
    const hours = Math.floor(bonusMinutes / 60);
    const mins  = bonusMinutes % 60;
    const timeStr = hours > 0 ? `${hours}h ${mins > 0 ? ` ${mins}min` : ''}`.trim() : `${mins} minutos`;

    return `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111827;">

        <!-- Header -->
        <div style="background:linear-gradient(135deg,#0F3460 0%,#16213E 100%);padding:40px 24px;text-align:center;border-radius:12px 12px 0 0;">
          <div style="font-size:52px;margin-bottom:10px;">⚡</div>
          <h1 style="color:#ffffff;margin:0;font-size:30px;font-weight:900;letter-spacing:-0.5px;">PrionBonus</h1>
          <p style="color:rgba(255,255,255,0.75);margin:8px 0 0;font-size:13px;letter-spacing:2px;text-transform:uppercase;">
            Tu tiempo · Tu esfuerzo · Tu recompensa
          </p>
        </div>

        <!-- Gift badge -->
        <div style="background:#fffbeb;padding:32px 28px;text-align:center;border-left:1px solid #fde68a;border-right:1px solid #fde68a;border-top:none;">
          <p style="color:#374151;font-size:17px;margin:0 0 6px;font-weight:600;">
            ¡Hola <span style="color:#0F3460;">${first}</span>! 🎉
          </p>
          <p style="color:#6b7280;font-size:14px;margin:0 0 24px;line-height:1.6;">
            Como parte del PrionLab, ahora formas parte del sistema <strong>PrionBonus</strong>.<br>
            Jokin te regala un bono de bienvenida por registrarte en PrionRead:
          </p>

          <div style="background:#0F3460;border-radius:20px;padding:28px 40px;display:inline-block;margin:0 auto;">
            <p style="color:rgba(255,255,255,0.65);font-size:11px;text-transform:uppercase;letter-spacing:3px;margin:0 0 6px;">Bono de bienvenida</p>
            <p style="color:#FBBF24;font-size:60px;font-weight:900;margin:0;line-height:1;letter-spacing:-2px;">+${timeStr}</p>
            <p style="color:rgba(255,255,255,0.65);font-size:12px;margin:8px 0 0;">del tiempo de Jokin</p>
          </div>
        </div>

        <!-- Explanation -->
        <div style="background:#ffffff;padding:28px 28px 8px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
          <h2 style="color:#0F3460;font-size:16px;font-weight:700;margin:0 0 16px;">¿Cómo funciona PrionBonus?</h2>

          <div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:14px;">
            <div style="width:36px;height:36px;min-width:36px;background:#EFF6FF;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;">📄</div>
            <div>
              <p style="margin:0;font-size:14px;font-weight:600;color:#1f2937;">Lees un artículo completo</p>
              <p style="margin:4px 0 0;font-size:13px;color:#6b7280;line-height:1.5;">
                Cuando completes un artículo (resumen + evaluación + valoración), ganas <strong>5 minutos por página</strong> de PDF.
                Un artículo de 10 páginas = 50 minutos del tiempo de Jokin.
              </p>
            </div>
          </div>

          <div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:14px;">
            <div style="width:36px;height:36px;min-width:36px;background:#F0FDF4;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;">⚡</div>
            <div>
              <p style="margin:0;font-size:14px;font-weight:600;color:#1f2937;">Acumulas tiempo de Jokin</p>
              <p style="margin:4px 0 0;font-size:13px;color:#6b7280;line-height:1.5;">
                Cada minuto ganado es tiempo real que Jokin te debe: reuniones, nuevas ideas para tu tesis,
                revisión de datos, feedback de resultados, …
              </p>
            </div>
          </div>

          <div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:24px;">
            <div style="width:36px;height:36px;min-width:36px;background:#FFF7ED;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;">⚖️</div>
            <div>
              <p style="margin:0;font-size:14px;font-weight:600;color:#1f2937;">El sistema lleva la cuenta</p>
              <p style="margin:4px 0 0;font-size:13px;color:#6b7280;line-height:1.5;">
                Cuando Jokin te dedica tiempo a tareas relacionadas con tu tesis, lo descuenta de tu saldo.
                El balance neto te muestra si vas 'al día' con la lectura científica.
              </p>
            </div>
          </div>
        </div>

        <!-- Notification note -->
        <div style="background:#f8fafc;padding:16px 28px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;border-top:1px solid #f3f4f6;">
          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;text-align:center;">
            📬 Cada vez que termines un artículo recibirás un email con los minutos ganados<br>
            y tu saldo actualizado. ¡Empieza a leer y acumula tiempo!
          </p>
        </div>

        <!-- CTA -->
        <div style="background:#ffffff;padding:20px 28px 32px;text-align:center;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
          <a href="${APP_URL}/bonus"
             style="display:inline-block;background:#0F3460;color:#fff;padding:14px 40px;
                    text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;letter-spacing:0.3px;">
            Ver mi saldo PrionBonus ⚡
          </a>
        </div>

        <!-- Footer -->
        <div style="background:#f9fafb;padding:16px 24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;text-align:center;">
          <p style="color:#9ca3af;font-size:12px;margin:0;">PrionRead · PrionBonus — Sistema de recompensa por lectura científica</p>
        </div>

      </div>
    `;
  },

  sendBonusIntroEmail: async (user, bonusMinutes = 200) => {
    const first = firstName(user.name);
    const hours = Math.floor(bonusMinutes / 60);
    const mins  = bonusMinutes % 60;
    const timeStr = hours > 0 ? `${hours}h ${mins > 0 ? ` ${mins}min` : ''}`.trim() : `${mins} minutos`;

    const html = emailService.buildBonusIntroHtml(user, bonusMinutes);
    await transporter.sendMail({
      from: `"PrionRead · PrionBonus" <${process.env.SMTP_USER}>`,
      to: user.email,
      subject: `⚡ ¡${first}, tienes ${timeStr} de PrionBonus esperándote!`,
      html,
    });
    console.log(`✉️  PrionBonus intro enviado a ${user.email} (${bonusMinutes} min)`);
  },

  // ─── PrionBonus earned notification ──────────────────────────────────────
  sendBonusEarnedEmail: async (user, { minutes, articleTitle, totalBalance }) => {
    const first = firstName(user.name);
    const hours = Math.floor(minutes / 60);
    const mins  = minutes % 60;
    const timeStr = hours > 0 ? `${hours}h ${mins}min` : `${mins} minutos`;

    const balHours = Math.floor(Math.abs(totalBalance) / 60);
    const balMins  = Math.abs(totalBalance) % 60;
    const balStr   = balHours > 0 ? `${balHours}h ${balMins}min` : `${Math.abs(totalBalance)} min`;
    const balColor = totalBalance >= 0 ? '#10B981' : '#EF4444';
    const balSign  = totalBalance >= 0 ? '+' : '−';

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111827;">

        <!-- Header -->
        <div style="background:#0F3460;padding:36px 24px;text-align:center;border-radius:12px 12px 0 0;">
          <div style="font-size:48px;margin-bottom:8px;">⚡</div>
          <h1 style="color:#ffffff;margin:0;font-size:28px;font-weight:800;letter-spacing:-0.5px;">¡PrionBonus!</h1>
          <p style="color:rgba(255,255,255,0.75);margin:8px 0 0;font-size:14px;letter-spacing:1px;text-transform:uppercase;">
            Tiempo del supervisor desbloqueado
          </p>
        </div>

        <!-- Reward badge -->
        <div style="background:#f0fdf4;padding:32px 24px;text-align:center;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
          <p style="color:#374151;font-size:16px;margin:0 0 16px;">
            Hola <strong>${first}</strong>, has ganado tiempo de Jokin por completar:
          </p>
          <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px 24px;display:inline-block;margin-bottom:20px;max-width:440px;width:100%;">
            <p style="margin:0;color:#0F3460;font-size:14px;font-weight:600;line-height:1.5;">
              📄 ${articleTitle}
            </p>
          </div>

          <div style="background:#0F3460;border-radius:16px;padding:24px 32px;display:inline-block;margin:0 auto;">
            <p style="color:rgba(255,255,255,0.7);font-size:12px;text-transform:uppercase;letter-spacing:2px;margin:0 0 4px;">Has ganado</p>
            <p style="color:#ffffff;font-size:52px;font-weight:900;margin:0;line-height:1;letter-spacing:-1px;">+${timeStr}</p>
            <p style="color:rgba(255,255,255,0.7);font-size:12px;margin:6px 0 0;">de tiempo de Jokin</p>
          </div>
        </div>

        <!-- Balance -->
        <div style="background:#ffffff;padding:24px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;">
            <span style="color:#6b7280;font-size:14px;">Saldo acumulado total</span>
            <span style="color:${balColor};font-size:20px;font-weight:800;">${balSign}${balStr}</span>
          </div>
          <p style="color:#6b7280;font-size:13px;text-align:center;margin:16px 0 0;line-height:1.6;">
            Sigue leyendo para acumular más tiempo —<br>
            <strong style="color:#0F3460;">cada artículo vale 5 min por página.</strong>
          </p>
        </div>

        <!-- CTA -->
        <div style="background:#ffffff;padding:16px 24px 32px;text-align:center;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
          <a href="${APP_URL}/bonus"
             style="display:inline-block;background:#0F3460;color:#fff;padding:14px 36px;
                    text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;">
            Ver mi saldo ⚡
          </a>
        </div>

        <!-- Footer -->
        <div style="background:#f9fafb;padding:16px 24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;text-align:center;">
          <p style="color:#9ca3af;font-size:12px;margin:0;">PrionRead · PrionBonus — Sistema de recompensa por lectura científica</p>
        </div>

      </div>
    `;

    await transporter.sendMail({
      from: `"PrionRead · PrionBonus" <${process.env.SMTP_USER}>`,
      to: user.email,
      subject: `⚡ ¡Has ganado ${timeStr} del tiempo de Jokin!`,
      html,
    });
    console.log(`✉️  PrionBonus enviado a ${user.email} (+${minutes} min)`);
  },

  // ─── Monthly report ──────────────────────────────────────────────────────

  buildMonthlyReportHtml: (user, data) => {
    const {
      monthName, periodYear,
      articlesThisMonth, totalReadCumulative, totalAssigned, completionPct,
      avgScoreThisMonth,
      minutesEarnedThisMonth, bonusCreditsThisMonth,
      minutesConsumedThisMonth, allocationsThisMonth,
      totalBalanceMinutes,
      pendingArticles,
    } = data;

    const first = firstName(user.name);

    const fmtMin = (m) => {
      const h = Math.floor(Math.abs(m) / 60);
      const min = Math.abs(m) % 60;
      if (h > 0 && min > 0) return `${h}h ${min}min`;
      if (h > 0) return `${h}h`;
      return `${min} min`;
    };

    const balanceColor  = totalBalanceMinutes >= 0 ? '#059669' : '#DC2626';
    const balanceSign   = totalBalanceMinutes >= 0 ? '+' : '−';
    const balanceLabel  = totalBalanceMinutes >= 0 ? 'Saldo a tu favor' : 'Deuda pendiente';

    const articleRows = articlesThisMonth.map((ua) => {
      const a = ua.article;
      const score = ua.latestScore;
      const authors = Array.isArray(a.authors)
        ? a.authors.slice(0, 2).join(', ')
        : (a.authors || '').split(',').slice(0, 2).join(', ');
      const milestoneTag = a.is_milestone
        ? `<div style="margin-top:5px;"><span style="background:#FEF3C7;color:#92400E;padding:2px 8px;border-radius:3px;font-size:11px;">★ Milestone</span></div>`
        : '';
      const scoreBadge = score != null
        ? `<td style="padding-left:10px;vertical-align:middle;white-space:nowrap;"><span style="background:#f0fdf4;color:#059669;border:1px solid #bbf7d0;border-radius:20px;padding:4px 10px;font-size:12px;font-weight:700;">⭐ ${Number(score).toFixed(1)}/10</span></td>`
        : '<td></td>';
      return `
        <tr>
          <td colspan="2" style="padding:0 0 10px;">
            <div style="border-left:3px solid ${a.is_milestone ? '#FBBF24' : '#4F46E5'};padding:10px 14px;background:#f9fafb;border-radius:0 8px 8px 0;">
              <table style="width:100%;border-collapse:collapse;"><tr>
                <td style="vertical-align:top;">
                  <p style="margin:0 0 3px;font-size:13px;font-weight:700;color:#111827;">${a.title}</p>
                  <p style="margin:0;font-size:11px;color:#6b7280;">${authors}${a.year ? ` · ${a.year}` : ''}</p>
                  ${milestoneTag}
                </td>
                ${scoreBadge}
              </tr></table>
            </div>
          </td>
        </tr>`;
    }).join('');

    const creditRows = bonusCreditsThisMonth.map((bc) => {
      const title = bc.article?.title || 'Artículo';
      return `
        <tr>
          <td style="padding:6px 0;font-size:13px;color:#374151;border-bottom:1px solid #f1f5f9;">📄 ${title.length > 55 ? title.slice(0,55)+'…' : title}</td>
          <td style="padding:6px 0;font-size:13px;font-weight:700;color:#FBBF24;text-align:right;border-bottom:1px solid #f1f5f9;white-space:nowrap;">+${fmtMin(bc.minutes_earned)}</td>
        </tr>`;
    }).join('');

    const allocationRows = allocationsThisMonth.map((al) => `
      <tr>
        <td style="padding:6px 0;font-size:13px;color:#374151;border-bottom:1px solid #f1f5f9;">🕐 ${al.description.length > 55 ? al.description.slice(0,55)+'…' : al.description}</td>
        <td style="padding:6px 0;font-size:13px;font-weight:700;color:#DC2626;text-align:right;border-bottom:1px solid #f1f5f9;white-space:nowrap;">−${fmtMin(al.minutes)}</td>
      </tr>`).join('');

    const pendingRows = pendingArticles.slice(0,3).map((a, i) => {
      const authors = Array.isArray(a.authors)
        ? a.authors.slice(0, 2).join(', ')
        : (a.authors || '').split(',').slice(0, 2).join(', ');
      return `
        <div style="border-left:3px solid ${a.is_milestone ? '#FBBF24' : '#6366F1'};padding:10px 14px;margin-bottom:8px;background:#f9fafb;border-radius:0 8px 8px 0;">
          <p style="margin:0 0 2px;font-size:13px;font-weight:700;color:#111827;">${i+1}. ${a.title}</p>
          <p style="margin:0;font-size:11px;color:#6b7280;">${authors}${a.year ? ` · ${a.year}` : ''}</p>
          ${a.is_milestone ? '<span style="background:#FEF3C7;color:#92400E;padding:2px 7px;border-radius:3px;font-size:11px;display:inline-block;margin-top:4px;">★ Milestone</span>' : ''}
        </div>`;
    }).join('');

    const noReadMsg = articlesThisMonth.length === 0
      ? `<div style="padding:20px;text-align:center;color:#6b7280;font-size:14px;font-style:italic;">Ningún artículo completado este mes — ¡aún estás a tiempo!</div>`
      : '';

    const jokinSection = (minutesConsumedThisMonth > 0 || allocationsThisMonth.length > 0) ? `
      <div style="background:#fff;padding:24px 24px 8px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
        <h2 style="color:#0F3460;font-size:13px;font-weight:700;margin:0 0 14px;text-transform:uppercase;letter-spacing:1px;">
          ⏱️ Tiempo dedicado por Jokin este mes
        </h2>
        ${allocationsThisMonth.length > 0 ? `
          <table style="width:100%;border-collapse:collapse;margin-bottom:14px;">
            ${allocationRows}
            <tr>
              <td style="padding:10px 0 0;font-size:13px;font-weight:700;color:#374151;">Total consumido</td>
              <td style="padding:10px 0 0;font-size:15px;font-weight:900;color:#DC2626;text-align:right;">−${fmtMin(minutesConsumedThisMonth)}</td>
            </tr>
          </table>` : `<p style="font-size:13px;color:#6b7280;margin:0 0 14px;">No se ha consumido tiempo de Jokin este mes.</p>`}
      </div>` : '';

    const avgScoreLine = avgScoreThisMonth != null
      ? `<td style="width:50%;padding:6px;"><div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;text-align:center;"><div style="font-size:26px;font-weight:900;color:#7C3AED;">${Number(avgScoreThisMonth).toFixed(1)}/10</div><div style="font-size:11px;color:#6b7280;margin-top:2px;">Nota media</div></div></td>`
      : `<td style="width:50%;padding:6px;"><div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;text-align:center;"><div style="font-size:26px;font-weight:900;color:#6366F1;">${totalAssigned > 0 ? `${completionPct}%` : '—'}</div><div style="font-size:11px;color:#6b7280;margin-top:2px;">Completitud</div></div></td>`;

    const motivations = [
      `¡Cada artículo que lees es munición intelectual para tu tesis!`,
      `La constancia es la clave del éxito científico. ¡Sigue así!`,
      `Tu progreso es real y se nota. ¡El conocimiento se acumula!`,
      `Cada paper leído te acerca a convertirte en experto. ¡No pares!`,
    ];
    const motivationMsg = motivations[new Date().getDate() % motivations.length];

    return `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111827;">

        <!-- Header -->
        <div style="background:#0F3460;padding:40px 28px;text-align:center;border-radius:12px 12px 0 0;">
          <p style="color:rgba(255,255,255,0.65);font-size:11px;text-transform:uppercase;letter-spacing:3px;margin:0 0 8px;">Resumen mensual · PrionRead</p>
          <h1 style="color:#ffffff;font-size:34px;font-weight:900;margin:0;letter-spacing:-1px;">${monthName} ${periodYear}</h1>
          <p style="color:rgba(255,255,255,0.8);font-size:15px;margin:10px 0 0;">Hola <strong>${first}</strong>, aquí está tu progreso del mes</p>
        </div>

        <!-- Stats grid -->
        <div style="background:#f0f4ff;padding:16px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
          <table style="width:100%;border-collapse:collapse;">
            <tr>
              <td style="width:50%;padding:6px;">
                <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;text-align:center;">
                  <div style="font-size:30px;font-weight:900;color:#0F3460;">${articlesThisMonth.length}</div>
                  <div style="font-size:11px;color:#6b7280;margin-top:2px;">Artículos este mes</div>
                </div>
              </td>
              <td style="width:50%;padding:6px;">
                <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;text-align:center;">
                  <div style="font-size:30px;font-weight:900;color:#059669;">${totalReadCumulative}</div>
                  <div style="font-size:11px;color:#6b7280;margin-top:2px;">Total acumulado</div>
                </div>
              </td>
            </tr>
            <tr>
              ${avgScoreLine}
              <td style="width:50%;padding:6px;">
                <div style="background:#0F3460;border:1px solid #0F3460;border-radius:10px;padding:14px;text-align:center;">
                  <div style="font-size:26px;font-weight:900;color:#FBBF24;">${minutesEarnedThisMonth > 0 ? '+'+fmtMin(minutesEarnedThisMonth) : '0 min'}</div>
                  <div style="font-size:11px;color:rgba(255,255,255,0.7);margin-top:2px;">Bonus ganado</div>
                </div>
              </td>
            </tr>
          </table>
        </div>

        <!-- Articles this month -->
        <div style="background:#fff;padding:24px 24px 4px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
          <h2 style="color:#0F3460;font-size:13px;font-weight:700;margin:0 0 14px;text-transform:uppercase;letter-spacing:1px;">
            📚 Artículos leídos en ${monthName}
          </h2>
          ${noReadMsg}
          ${articlesThisMonth.length > 0 ? `<table style="width:100%;border-collapse:collapse;">${articleRows}</table>` : ''}
        </div>

        <!-- PrionBonus section -->
        <div style="background:#16213E;padding:24px;border-left:1px solid #0a1628;border-right:1px solid #0a1628;">
          <h2 style="color:#FBBF24;font-size:13px;font-weight:700;margin:0 0 14px;text-transform:uppercase;letter-spacing:1px;">
            ⚡ PrionBonus — ${monthName}
          </h2>
          ${bonusCreditsThisMonth.length > 0 ? `
            <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
              ${creditRows}
              <tr>
                <td style="padding:10px 0 0;font-size:13px;font-weight:700;color:rgba(255,255,255,0.85);">Total ganado este mes</td>
                <td style="padding:10px 0 0;font-size:16px;font-weight:900;color:#FBBF24;text-align:right;">+${fmtMin(minutesEarnedThisMonth)}</td>
              </tr>
            </table>` :
            `<p style="font-size:13px;color:rgba(255,255,255,0.55);margin:0 0 16px;">No se han generado créditos bonus este mes.</p>`}
          <!-- Global balance -->
          <div style="background:rgba(255,255,255,0.07);border-radius:10px;padding:14px 18px;">
            <table style="width:100%;border-collapse:collapse;"><tr>
              <td style="font-size:13px;color:rgba(255,255,255,0.7);">${balanceLabel} (saldo global)</td>
              <td style="font-size:20px;font-weight:900;color:${totalBalanceMinutes >= 0 ? '#34D399' : '#F87171'};text-align:right;">${balanceSign}${fmtMin(totalBalanceMinutes)}</td>
            </tr></table>
          </div>
        </div>

        <!-- Tiempo de Jokin -->
        ${jokinSection}

        <!-- Progress bar -->
        <div style="background:#fff;padding:20px 24px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
          <p style="font-size:12px;color:#6b7280;margin:0 0 8px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">Progreso total de tu lista</p>
          <div style="background:#e5e7eb;border-radius:100px;height:12px;overflow:hidden;">
            <div style="background:#4F46E5;height:12px;width:${completionPct}%;border-radius:100px;"></div>
          </div>
          <table style="width:100%;border-collapse:collapse;margin-top:6px;"><tr>
            <td style="font-size:12px;color:#4F46E5;font-weight:700;">${completionPct}% completado</td>
            <td style="font-size:12px;color:#6b7280;text-align:right;">${totalReadCumulative} de ${totalAssigned} artículos</td>
          </tr></table>
        </div>

        ${pendingArticles.length > 0 ? `
        <!-- Next up -->
        <div style="background:#faf5ff;padding:24px;border-left:1px solid #e9d5ff;border-right:1px solid #e9d5ff;border-top:1px solid #f3e8ff;">
          <h2 style="color:#7C3AED;font-size:13px;font-weight:700;margin:0 0 14px;text-transform:uppercase;letter-spacing:1px;">
            🎯 Próximas lecturas recomendadas
          </h2>
          ${pendingRows}
        </div>` : ''}

        <!-- Motivational message -->
        <div style="background:#fff;padding:24px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;border-top:1px solid #f1f5f9;">
          <div style="background:#f0fdf4;border-left:4px solid #10B981;padding:16px 18px;border-radius:0 8px 8px 0;">
            <p style="margin:0;font-size:14px;color:#065f46;line-height:1.7;">
              💬 <em>${motivationMsg}</em><br>
              <span style="font-size:12px;color:#6b7280;margin-top:6px;display:block;">
                Recuerda: 2–3 artículos por semana es el ritmo ideal. Cada artículo completado son <strong>5 min por página</strong> de tiempo de Jokin a tu disposición.
              </span>
            </p>
          </div>
        </div>

        <!-- CTA buttons -->
        <div style="background:#fff;padding:16px 24px 32px;text-align:center;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
          <a href="${APP_URL}/my-articles"
             style="display:inline-block;background:#4F46E5;color:#fff;padding:13px 28px;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;margin:4px 6px;">
            Ver mis artículos →
          </a>
          <a href="${APP_URL}/bonus"
             style="display:inline-block;background:#0F3460;color:#fff;padding:13px 28px;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;margin:4px 6px;">
            Ver PrionBonus ⚡
          </a>
        </div>

        <!-- Footer -->
        <div style="background:#f9fafb;padding:16px 24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;text-align:center;">
          <p style="color:#9ca3af;font-size:12px;margin:0;">PrionRead · Resumen mensual automático — ${monthName} ${periodYear}</p>
        </div>

      </div>
    `;
  },

  sendMonthlyReportEmail: async (user, data, adminEmails = []) => {
    const html = emailService.buildMonthlyReportHtml(user, data);
    const { monthName, periodYear } = data;
    const subject = `📊 Tu resumen mensual PrionRead — ${monthName} ${periodYear}`;
    await transporter.sendMail({
      from: `"PrionRead" <${process.env.SMTP_USER}>`,
      to: user.email,
      cc: adminEmails.length > 0 ? adminEmails.join(', ') : undefined,
      subject,
      html,
    });
    console.log(`✉️  Resumen mensual enviado a ${user.email} (CC: ${adminEmails.join(', ') || '—'})`);
  },

  // ─── Threshold alert to admin ──────────────────────────────────────────────
  async sendThresholdAlertEmail(admin, student, rule, stats) {
    const { total, pending } = stats;
    const readCount = total - pending;
    const completedPct = total > 0 ? Math.round((readCount / total) * 100) : 0;
    const pendingPct   = total > 0 ? Math.round((pending / total) * 100) : 0;

    const conditionDesc = rule.type === 'articles_remaining'
      ? `le quedan solo <strong>${pending}</strong> artículo${pending !== 1 ? 's' : ''} pendientes (umbral configurado: ≤ ${rule.threshold})`
      : `le queda por leer el <strong>${pendingPct}%</strong> de sus artículos asignados (umbral configurado: ≤ ${rule.threshold}%)`;

    const subject = rule.type === 'articles_remaining'
      ? `🔔 PrionRead — ${student.name} le quedan solo ${pending} artículo${pending !== 1 ? 's' : ''} pendientes`
      : `🔔 PrionRead — ${student.name} ha completado el ${completedPct}% de su lista de lectura`;

    const html = base(`
      <div style="background:#4F46E5;padding:28px 24px;text-align:center;border-radius:12px 12px 0 0;">
        <p style="color:rgba(255,255,255,0.8);font-size:12px;margin:0 0 6px;letter-spacing:2px;text-transform:uppercase;">Alerta de Seguimiento</p>
        <h1 style="color:#fff;margin:0;font-size:22px;">🔔 Progreso del Estudiante</h1>
        <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:14px;">PrionRead · Panel de Administración</p>
      </div>
      <div style="background:#fff;padding:28px 24px;border:1px solid #e5e7eb;border-top:none;">

        <p style="font-size:15px;margin-top:0;">Hola <strong>${admin.name}</strong>,</p>
        <p style="color:#374151;line-height:1.7;font-size:14px;">
          El estudiante <strong>${student.name}</strong>
          (<a href="mailto:${student.email}" style="color:#4F46E5;">${student.email}</a>)
          ${conditionDesc}.
        </p>

        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin:20px 0;">
          <p style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;margin:0 0 14px;letter-spacing:1px;">
            Estadísticas actuales
          </p>
          <table style="width:100%;border-collapse:collapse;">
            <tr>
              <td style="padding:8px 0;font-size:14px;color:#374151;border-bottom:1px solid #f1f5f9;">
                📚 Artículos asignados
              </td>
              <td style="padding:8px 0;font-size:15px;font-weight:700;color:#111827;text-align:right;border-bottom:1px solid #f1f5f9;">
                ${total}
              </td>
            </tr>
            <tr>
              <td style="padding:8px 0;font-size:14px;color:#374151;border-bottom:1px solid #f1f5f9;">
                ✅ Artículos leídos
              </td>
              <td style="padding:8px 0;font-size:15px;font-weight:700;color:#059669;text-align:right;border-bottom:1px solid #f1f5f9;">
                ${readCount}
              </td>
            </tr>
            <tr>
              <td style="padding:8px 0;font-size:14px;color:#374151;">
                ⏳ Artículos pendientes
              </td>
              <td style="padding:8px 0;font-size:15px;font-weight:700;color:#d97706;text-align:right;">
                ${pending}
              </td>
            </tr>
          </table>

          <div style="margin-top:18px;">
            <div style="background:#e0e7ff;border-radius:100px;height:10px;overflow:hidden;">
              <div style="background:#4F46E5;height:10px;width:${completedPct}%;border-radius:100px;transition:width 0.3s;"></div>
            </div>
            <p style="text-align:right;font-size:12px;color:#6b7280;margin:5px 0 0;">
              ${completedPct}% completado · ${pendingPct}% pendiente
            </p>
          </div>
        </div>

        ${rule.label ? `<p style="color:#6b7280;font-size:13px;font-style:italic;margin-bottom:16px;">📌 Regla activa: <em>${rule.label}</em></p>` : ''}

        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px 18px;font-size:13px;color:#92400e;line-height:1.6;">
          Esta notificación se enviará <strong>una vez al día</strong> mientras se mantenga la condición.<br>
          Puedes gestionar las reglas de notificación desde el panel de administración de PrionRead.
        </div>

        <div style="text-align:center;margin-top:24px;">
          <a href="${APP_URL}/admin/dashboard"
             style="display:inline-block;background:#4F46E5;color:#fff;padding:12px 28px;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">
            Ir al Panel de Administración
          </a>
        </div>
      </div>
    `);

    await transporter.sendMail({
      from: `"PrionRead" <${process.env.SMTP_USER}>`,
      to: admin.email,
      subject,
      html,
    });
    console.log(`✉️  Alerta de umbral enviada a ${admin.email} sobre ${student.name}`);
  },
};

module.exports = emailService;
