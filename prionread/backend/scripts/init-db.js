require('dotenv').config();
const { User, sequelize } = require('../models');
const bcrypt = require('bcrypt');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

async function initDatabase() {
  try {
    await sequelize.authenticate();
    console.log('✅ Conectado a la base de datos\n');

    const existingAdmin = await User.findOne({ where: { role: 'admin' } });

    if (existingAdmin) {
      console.log('⚠️  Ya existe un administrador en la base de datos:');
      console.log(`   Nombre: ${existingAdmin.name}`);
      console.log(`   Email:  ${existingAdmin.email}\n`);

      const overwrite = await question('¿Crear un nuevo administrador de todos modos? (s/N): ');
      if (overwrite.toLowerCase() !== 's') {
        console.log('Operación cancelada.');
        rl.close();
        process.exit(0);
      }
    }

    console.log('\n🔧 Creando nuevo administrador...\n');

    const name = await question('Nombre: ');
    const email = await question('Email: ');
    const password = await question('Contraseña: ');

    if (!name.trim() || !email.trim() || !password.trim()) {
      console.error('❌ Todos los campos son obligatorios.');
      rl.close();
      process.exit(1);
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const admin = await User.create({ name, email, password: hashedPassword, role: 'admin' });

    console.log('\n✅ Administrador creado correctamente:');
    console.log(`   ID:     ${admin.id}`);
    console.log(`   Nombre: ${admin.name}`);
    console.log(`   Email:  ${admin.email}`);
    console.log('\n🎉 Ya puedes iniciar sesión en la aplicación!');

    rl.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message || error);
    rl.close();
    process.exit(1);
  }
}

initDatabase();
