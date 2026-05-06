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

if (!process.env.FRONTEND_URL) {
  console.warn('⚠️  FRONTEND_URL no está definida — los enlaces en emails no funcionarán correctamente.');
}

const firstName = (name) => (name || '').trim().split(/\s+/)[0];

const FRONTEND_URL = (process.env.FRONTEND_URL || '').replace(/\/$/, '');

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
          <a href="${FRONTEND_URL}/login"
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
          <a href="${FRONTEND_URL}/login"
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
          <a href="${FRONTEND_URL}/login"
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
          <a href="${FRONTEND_URL}/my-articles"
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
          <a href="${FRONTEND_URL}/dashboard"
             style="display: inline-block; background-color: #4F46E5; color: white; padding: 12px 24px;
                    text-decoration: none; border-radius: 6px; margin-top: 20px;">
            Ir a PrionRead
          </a>
        </p>
      `),
    });
    console.log(`✉️  Email personalizado enviado a ${user.email}`);
  },
};

module.exports = emailService;
