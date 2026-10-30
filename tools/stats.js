/**
 * stats.js - Semantic Brain statistics and health metrics
 *
 * Usage: node tools/stats.js [--verbose] [--json] [--project=erp]
 */
const { pool } = require('../core');

const VERBOSE = process.argv.includes('--verbose');
const JSON_MODE = process.argv.includes('--json');
const PROJECT = (() => {
  const arg = process.argv.find(a => a.startsWith('--project='));
  return arg ? arg.split('=')[1].trim().toLowerCase() : null;
})();

async function getStats() {
  const projectFilter = PROJECT ? `AND project_id = '${PROJECT.replace(/'/g, "''")}'` : '';

  try {
    if (!JSON_MODE) console.log(`=== SEMANTIC BRAIN STATISTICS ${PROJECT ? `[project: ${PROJECT}]` : '[all projects]'} ===\n`);

    // QA Cache stats
    const qaStats = await pool.query(`
      SELECT
        COUNT(*)::int as total,
        AVG(confidence_score) as avg_confidence,
        SUM(hit_count)::int as total_hits,
        COUNT(CASE WHEN confidence_score < 0.5 THEN 1 END)::int as low_confidence,
        COUNT(CASE WHEN hit_count = 0 THEN 1 END)::int as never_used,
        COUNT(CASE WHEN hit_count > 0 THEN 1 END)::int as used,
        COUNT(CASE WHEN tags IS NULL OR array_length(tags,1) IS NULL THEN 1 END)::int as no_tags,
        COUNT(CASE WHEN hit_count = 0 AND created_at < NOW() - INTERVAL '60 days' THEN 1 END)::int as ultra_cold,
        ROUND(100.0 * COUNT(CASE WHEN hit_count > 0 THEN 1 END) / NULLIF(COUNT(*), 0), 1) as use_pct,
        COUNT(CASE WHEN updated_at > NOW() - INTERVAL '7 days' THEN 1 END)::int as recent_updates
      FROM agent_qa_cache
      WHERE 1=1 ${projectFilter}
    `);

    const qa = qaStats.rows[0];

    // JSON mode: output for post-task health check
    if (JSON_MODE) {
      console.log(JSON.stringify(qa));
      return; // finally sẽ gọi pool.end()
    }

    console.log('📚 QA Cache:');
    console.log(`   Total entries: ${qa.total}`);
    console.log(`   Avg confidence: ${parseFloat(qa.avg_confidence || 0).toFixed(2)}`);
    console.log(`   Total hits: ${qa.total_hits}`);
    console.log(`   Low confidence (<0.5): ${qa.low_confidence}`);
    console.log(`   Never used: ${qa.never_used}`);
    console.log(`   Updated (7d): ${qa.recent_updates}\n`);

    // Recipe stats
    const recipeStats = await pool.query(`
      SELECT
        COUNT(*) as total,
        SUM(hit_count) as total_hits,
        SUM(success_count) as total_success,
        AVG(CASE WHEN hit_count > 0 THEN success_count::float / hit_count ELSE 0 END) as avg_success_rate,
        COUNT(CASE WHEN hit_count = 0 THEN 1 END) as never_used,
        COUNT(CASE WHEN hit_count >= 2 AND (success_count::float / hit_count) < 0.5 THEN 1 END) as low_success
      FROM agent_recipes
    `);

    const recipe = recipeStats.rows[0];
    console.log('🍳 Recipes:');
    console.log(`   Total recipes: ${recipe.total}`);
    console.log(`   Total hits: ${recipe.total_hits}`);
    console.log(`   Total success: ${recipe.total_success}`);
    console.log(`   Avg success rate: ${(parseFloat(recipe.avg_success_rate) * 100).toFixed(1)}%`);
    console.log(`   Never used: ${recipe.never_used}`);
    console.log(`   Low success (<50%): ${recipe.low_success}\n`);

    // Registry stats
    const registryStats = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(DISTINCT type) as types
      FROM agent_registry
    `);

    const reg = registryStats.rows[0];
    console.log('🔧 Registry:');
    console.log(`   Total skills: ${reg.total}`);
    console.log(`   Skill types: ${reg.types}\n`);

    // Top QA by hits
    if (VERBOSE) {
      console.log('📊 Top 10 QA by hits:');
      const topQA = await pool.query(`
        SELECT question, hit_count, confidence_score
        FROM agent_qa_cache
        ORDER BY hit_count DESC
        LIMIT 10
      `);
      topQA.rows.forEach((r, i) => {
        console.log(`   ${i + 1}. [${r.hit_count} hits, conf: ${r.confidence_score.toFixed(2)}] ${r.question.substring(0, 60)}...`);
      });
      console.log();

      // Top Recipes by success rate
      console.log('🏆 Top 10 Recipes by success rate:');
      const topRecipes = await pool.query(`
        SELECT intent, hit_count, success_count,
               CASE WHEN hit_count > 0 THEN (success_count::float / hit_count * 100) ELSE 0 END as success_rate
        FROM agent_recipes
        WHERE hit_count >= 2
        ORDER BY success_rate DESC, hit_count DESC
        LIMIT 10
      `);
      topRecipes.rows.forEach((r, i) => {
        console.log(`   ${i + 1}. [${r.success_rate.toFixed(0)}%, ${r.hit_count} hits] ${r.intent.substring(0, 60)}...`);
      });
      console.log();
    }

    // Health recommendations
    console.log('💡 Recommendations:');
    if (parseInt(qa.low_confidence) > 0) {
      console.log(`   ⚠️  ${qa.low_confidence} QA entries have low confidence - run: node list-low-score.js`);
    }
    if (parseInt(qa.never_used) > parseInt(qa.total) * 0.3) {
      console.log(`   ⚠️  ${qa.never_used} QA entries never used - consider cleanup`);
    }
    if (parseInt(recipe.low_success) > 0) {
      console.log(`   ⚠️  ${recipe.low_success} recipes have low success rate - review and update`);
    }
    if (parseInt(qa.low_confidence) === 0 && parseInt(recipe.low_success) === 0) {
      console.log(`   ✅ All metrics healthy!`);
    }

  } catch (err) {
    console.error('[ERROR]', err.message);
  } finally {
    await pool.end();
  }
}

getStats();
