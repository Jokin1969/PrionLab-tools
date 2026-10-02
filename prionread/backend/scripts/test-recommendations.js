require('dotenv').config();
const recommendationEngine = require('../utils/recommendationEngine');
const { sequelize, User } = require('../models');

async function testRecommendations() {
  try {
    await sequelize.authenticate();
    console.log('✅ Conectado a la base de datos');

    const testUser = await User.findOne({ where: { role: 'student' } });
    if (!testUser) {
      console.log('❌ No hay usuarios estudiantes en la DB');
      process.exit(0);
    }

    console.log(`\n🎯 Generando recomendaciones para: ${testUser.name}`);

    const recommendations = await recommendationEngine.generateRecommendations(testUser.id, 5);

    console.log('\n📚 Top 5 Recomendaciones:');
    recommendations.forEach((article, idx) => {
      console.log(`\n${idx + 1}. ${article.title}`);
      console.log(`   Score:     ${article.recommendation_score.toFixed(2)}`);
      console.log(`   Milestone: ${article.is_milestone ? 'Sí' : 'No'}`);
      console.log(`   Prioridad: ${article.priority}`);
      console.log(`   Tags:      ${article.tags?.join(', ') || 'N/A'}`);
    });

    console.log('\n📊 Análisis de Gaps:');
    const gaps = await recommendationEngine.analyzeReadingGaps(testUser.id);
    console.log(`   Leídos:               ${gaps.totalRead}`);
    console.log(`   Pendientes:           ${gaps.totalPending}`);
    console.log(`   Milestones no leídos: ${gaps.unreadMilestones}`);
    if (gaps.underrepresentedTags.length) {
      console.log('\n   Tags con poca cobertura:');
      gaps.underrepresentedTags.slice(0, 5).forEach((t) => {
        console.log(`     - ${t.tag}: ${t.coverage}/${t.total} (${t.coveragePercent}%)`);
      });
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

testRecommendations();
