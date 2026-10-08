require('dotenv').config();
const notificationService = require('../services/notificationService');
const { sequelize, User } = require('../models');

const [,, mode, userId] = process.argv;

async function run() {
  await sequelize.authenticate();
  console.log('✅ Conectado a la base de datos');

  if (mode === 'weekly') {
    console.log('\n📧 Enviando recordatorios semanales a todos los estudiantes...');
    const results = await notificationService.sendWeeklyRemindersToAll();
    console.log(`\n   Enviados: ${results.sent}`);
    console.log(`   Omitidos: ${results.skipped}`);
    console.log(`   Errores:  ${results.errors}`);
  } else if (mode === 'inactivity') {
    console.log('\n💤 Enviando recordatorios de inactividad...');
    const results = await notificationService.sendInactivityReminders();
    console.log(`\n   Enviados: ${results.sent}`);
    console.log(`   Omitidos: ${results.skipped}`);
    console.log(`   Errores:  ${results.errors}`);
  } else if (mode === 'user') {
    if (!userId) {
      console.error('❌ Uso: node test-notifications.js user <userId>');
      process.exit(1);
    }
    const user = await User.findByPk(userId);
    if (!user) {
      console.error(`❌ Usuario ${userId} no encontrado`);
      process.exit(1);
    }
    console.log(`\n📨 Enviando recordatorio semanal a: ${user.name} <${user.email}>`);
    const result = await notificationService.sendWeeklyReminder(user);
    if (result.sent) console.log('   ✅ Email enviado');
    else console.log(`   ⚠️  Omitido: ${result.reason}`);
  } else {
    console.log('Uso: node test-notifications.js <weekly|inactivity|user> [userId]');
    console.log('\n  weekly      — recordatorios semanales a todos los estudiantes');
    console.log('  inactivity  — recordatorios a estudiantes inactivos (≥14 días)');
    console.log('  user <id>   — recordatorio semanal a un usuario específico');
    process.exit(0);
  }

  process.exit(0);
}

run().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
