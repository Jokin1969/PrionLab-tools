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

const FRONTEND_URL = (process.env.FRONTEND_URL || '').replace(/\/$/, '');

const base = (content) => `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
    ${content}
    <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;">
    <p style="color: #6b7280; font-size: 12px;">
      PrionRead – Sistema de Gestión de Lectura Científica
    </p>
  </div>
`;

const emailService = {
  sendWelcomeEmail: async (user, tempPassword) => {
    await transporter.sendMail({
      from: `"PrionRead" <${process.env.SMTP_USER}>`,
      to: user.email,
      subject: '🎓 Bienvenido a PrionRead',
      html: base(`
        <h1 style="color: #4F46E5;">¡Bienvenido a PrionRead!</h1>
        <p>Hola ${user.name},</p>
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

  sendPasswordResetEmail: async (user, tempPassword) => {
    await transporter.sendMail({
      from: `"PrionRead" <${process.env.SMTP_USER}>`,
      to: user.email,
      subject: '🔑 Tu contraseña ha sido reseteada',
      html: base(`
        <h1 style="color: #4F46E5;">Contraseña Reseteada</h1>
        <p>Hola ${user.name},</p>
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
        <p>Hola ${user.name},</p>
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
        <p>Hola ${user.name},</p>
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
