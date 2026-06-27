#!/usr/bin/env node
'use strict';

/**
 * AGENTIC KDD v2.2 — CI/CD INTEGRATION
 * 
 * Registra automáticamente fallos de CI/CD en la memoria episódica.
 * La memoria crece sola — sin que el dev haga nada.
 * 
 * Cómo funciona:
 *   1. GitHub Actions corre el workflow .github/workflows/agentic-kdd.yml
 *   2. Si los tests fallan, el workflow llama: akdd ci-report
 *   3. akdd ci-report registra el fallo como episodio en memoria.db
 *   4. La próxima vez que el Analista busca contexto, encuentra este episodio
 * 
 * También soporta:
 *   - Salida JSON para integración con cualquier CI (GitLab, Bitbucket, Jenkins)
 *   - Webhook HTTP simple para registros remotos
 *   - Variables de entorno estándar de CI
 * 
 * Comandos:
 *   akdd ci-report                    → registra fallo desde variables CI
 *   akdd ci-report --success          → registra éxito
 *   akdd ci-install                   → instala .github/workflows/agentic-kdd.yml
 *   akdd ci-status                    → últimos 10 reportes CI en memoria
 */

const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

// ─── Detectar entorno CI ───────────────────────────────────────────────────────
function detectarEnvCI() {
  return {
    es_ci:       !!(process.env.CI || process.env.GITHUB_ACTIONS || process.env.GITLAB_CI || 
                    process.env.BITBUCKET_BUILD_NUMBER || process.env.JENKINS_URL),
    plataforma:  process.env.GITHUB_ACTIONS ? 'github' : 
                 process.env.GITLAB_CI      ? 'gitlab' : 
                 process.env.BITBUCKET_BUILD_NUMBER ? 'bitbucket' :
                 process.env.JENKINS_URL    ? 'jenkins' : 'local',
    
    // GitHub Actions
    repo:        process.env.GITHUB_REPOSITORY || process.env.CI_PROJECT_NAME || 'unknown',
    rama:        process.env.GITHUB_REF_NAME || process.env.CI_COMMIT_REF_NAME || 'unknown',
    commit:      (process.env.GITHUB_SHA || process.env.CI_COMMIT_SHA || '').slice(0, 8),
    actor:       process.env.GITHUB_ACTOR || process.env.GITLAB_USER_NAME || 'ci',
    workflow:    process.env.GITHUB_WORKFLOW || process.env.CI_PIPELINE_NAME || 'unknown',
    run_id:      process.env.GITHUB_RUN_ID || process.env.CI_PIPELINE_ID || Date.now().toString(),
    pr_number:   process.env.GITHUB_REF?.match(/refs\/pull\/(\d+)/)?.[1] || null,
    
    // URL del run para referencia
    run_url:     process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
                   ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
                   : null
  };
}

// ─── Parsear output de tests ───────────────────────────────────────────────────
function parsearOutputTests(output) {
  if (!output) return { pasando: 0, fallando: 0, errores: [], suites: [] };
  
  const resultado = {
    pasando:  parseInt(output.match(/(\d+)\s+pass(?:ed|ing)/i)?.[1]  || '0'),
    fallando: parseInt(output.match(/(\d+)\s+fail(?:ed|ing)/i)?.[1]  || '0'),
    omitidos: parseInt(output.match(/(\d+)\s+(?:skip|pending)/i)?.[1]|| '0'),
    errores:  [],
    suites:   [],
    duracion: output.match(/Time:\s+([\d.]+\s*[ms]+)/i)?.[1] || null
  };
  
  // Extraer nombres de tests fallidos
  const testsFailRegex = /✕|✗|FAIL|×|●\s+(.+?)(?:\n|$)/gm;
  let m;
  while ((m = testsFailRegex.exec(output)) !== null) {
    const test = m[1]?.trim();
    if (test && test.length > 5 && test.length < 200) {
      resultado.errores.push(test);
    }
  }
  resultado.errores = [...new Set(resultado.errores)].slice(0, 10);
  
  // Extraer suites fallidas
  const suitesRegex = /FAIL\s+([^\s]+\.(test|spec)\.[jt]s(?:x?)?)/gm;
  while ((m = suitesRegex.exec(output)) !== null) {
    resultado.suites.push(m[1]);
  }
  
  return resultado;
}

// ─── Detectar archivos modificados en el commit ───────────────────────────────
function getArchivosCommit(projectPath) {
  try {
    const { execSync } = require('child_process');
    const commit = process.env.GITHUB_SHA || 'HEAD';
    const archivos = execSync(
      `git diff-tree --no-commit-id -r --name-only ${commit}`,
      { cwd: projectPath, stdio: 'pipe' }
    ).toString().trim();
    return archivos.split('\n').filter(Boolean);
  } catch(e) { return []; }
}

// ─── Registrar reporte CI en memoria episódica ────────────────────────────────
function registrarReporteCI(db, datos) {
  const episodio_id = `ci-${datos.run_id || Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  
  const descripcion = datos.es_exito
    ? `CI/CD PASS — ${datos.workflow} en ${datos.rama} [${datos.commit}]. Tests: ${datos.tests_pasando}/${datos.tests_total} pasando.`
    : `CI/CD FAIL — ${datos.workflow} en ${datos.rama} [${datos.commit}]. ${datos.tests_fallando} tests fallando. ${datos.errores?.slice(0,3).join(', ') || ''}`;
  
  try {
    db.run(
      `INSERT INTO episodios 
        (episodio_id, tipo, descripcion, accion_tomada, resultado, razon_resultado,
         archivos_tocados, area, modulo, fecha)
       VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`,
      episodio_id,
      datos.es_exito ? 'accion' : 'error',
      descripcion,
      datos.es_exito ? `CI verde en ${datos.rama}` : `Fallo en CI — ${datos.run_url || 'ver CI'}`,
      datos.es_exito ? 'exito' : 'fallo',
      datos.es_exito 
        ? `Tests pasaron en ${datos.rama}` 
        : `${datos.tests_fallando} tests fallando. ${datos.errores?.slice(0,3).join(' | ') || 'Ver output'}`,
      JSON.stringify(datos.archivos_tocados || []),
      datos.area || 'ci-cd',
      datos.modulo || datos.rama || 'global'
    );
    
    return episodio_id;
  } catch(e) {
    return null;
  }
}

// ─── COMANDO PRINCIPAL: akdd ci-report ───────────────────────────────────────
function reportarCI(projectPath, db, opciones) {
  opciones = opciones || {};
  const env = detectarEnvCI();
  
  // Leer output de tests desde stdin o archivo
  let testOutput = '';
  if (opciones.outputFile && fs.existsSync(opciones.outputFile)) {
    testOutput = fs.readFileSync(opciones.outputFile, 'utf8');
  } else if (opciones.output) {
    testOutput = opciones.output;
  }
  
  const testsInfo = parsearOutputTests(testOutput);
  const archivos  = getArchivosCommit(projectPath);
  
  const datos = {
    es_exito:       opciones.esExito || false,
    workflow:       env.workflow,
    rama:           env.rama,
    commit:         env.commit,
    actor:          env.actor,
    repo:           env.repo,
    run_id:         env.run_id,
    run_url:        env.run_url,
    pr_number:      env.pr_number,
    tests_pasando:  testsInfo.pasando,
    tests_fallando: testsInfo.fallando,
    tests_total:    testsInfo.pasando + testsInfo.fallando,
    errores:        testsInfo.errores,
    suites_fallidas: testsInfo.suites,
    archivos_tocados: archivos,
    area:           'ci-cd',
    modulo:         env.rama
  };
  
  const episodioId = registrarReporteCI(db, datos);
  
  if (episodioId) {
    // También sync el grafo para consolidar
    try {
      const grafoPath = path.join(projectPath, '.agentic', 'grafo', 'grafo.cjs');
      if (fs.existsSync(grafoPath)) {
        const { execSync } = require('child_process');
        execSync(`node "${grafoPath}" sync`, { stdio: 'pipe', cwd: projectPath, timeout: 30000 });
      }
    } catch(e) {}
    
    console.log(`  ✓ CI report registrado: ${episodioId}`);
    if (!datos.es_exito && datos.tests_fallando > 0) {
      console.log(`  Tests fallando: ${datos.tests_fallando}`);
      datos.errores.slice(0, 3).forEach(e => console.log(`    · ${e}`));
    }
  } else {
    console.log('  ⚠ No se pudo registrar (Agentic KDD no instalado?)');
    process.exit(1);
  }
  
  return { episodioId, datos };
}

// ─── INSTALAR WORKFLOW DE GITHUB ACTIONS ────────────────────────────────────
function instalarWorkflow(projectPath) {
  const workflowDir  = path.join(projectPath, '.github', 'workflows');
  const workflowPath = path.join(workflowDir, 'agentic-kdd.yml');
  
  // Detectar el comando de tests del proyecto
  let testCmd = 'npm test';
  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts?.test && pkg.scripts.test !== 'echo \"Error: no test specified\"') {
        testCmd = 'npm test';
      } else if (pkg.devDependencies?.jest || pkg.dependencies?.jest) {
        testCmd = 'npx jest';
      } else if (pkg.devDependencies?.vitest) {
        testCmd = 'npx vitest run';
      }
    } catch(e) {}
  } else if (fs.existsSync(path.join(projectPath, 'artisan'))) {
    testCmd = 'php artisan test';
  } else if (fs.existsSync(path.join(projectPath, 'pytest.ini')) || 
             fs.existsSync(path.join(projectPath, 'pyproject.toml'))) {
    testCmd = 'python -m pytest';
  }
  
  const workflow = `# Agentic KDD — CI/CD Integration
# Registra automáticamente fallos de tests en la memoria episódica
# Documentación: https://github.com/Adrianlpz211/Agentic-KDD

name: Agentic KDD CI

on:
  push:
    branches: [ main, master, develop, staging ]
  pull_request:
    branches: [ main, master ]

jobs:
  test:
    runs-on: ubuntu-latest
    
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run tests
        id: tests
        run: ${testCmd} 2>&1 | tee test-output.txt
        continue-on-error: true
      
      - name: Install Agentic KDD
        if: always()
        run: npm install -g agentic-kdd
      
      - name: Report to Agentic KDD Memory
        if: always()
        run: |
          # Registrar resultado en memoria episódica
          if [ "\${{ steps.tests.outcome }}" == "success" ]; then
            akdd ci-report --success --output test-output.txt 2>/dev/null || true
          else
            akdd ci-report --output test-output.txt 2>/dev/null || true
          fi
        env:
          # Pasar variables de entorno de CI a akdd
          GITHUB_ACTIONS: true
          GITHUB_SHA: \${{ github.sha }}
          GITHUB_REF_NAME: \${{ github.ref_name }}
          GITHUB_ACTOR: \${{ github.actor }}
          GITHUB_REPOSITORY: \${{ github.repository }}
          GITHUB_WORKFLOW: \${{ github.workflow }}
          GITHUB_RUN_ID: \${{ github.run_id }}
          GITHUB_SERVER_URL: \${{ github.server_url }}
      
      - name: Fail if tests failed
        if: steps.tests.outcome == 'failure'
        run: exit 1
`;
  
  try {
    fs.mkdirSync(workflowDir, { recursive: true });
    
    if (fs.existsSync(workflowPath)) {
      const backup = workflowPath.replace('.yml', `.backup-${Date.now()}.yml`);
      fs.copyFileSync(workflowPath, backup);
      console.log(`  ⚠ Backup del workflow anterior: ${path.basename(backup)}`);
    }
    
    fs.writeFileSync(workflowPath, workflow);
    console.log(`\n  ✓ Workflow instalado: .github/workflows/agentic-kdd.yml`);
    console.log(`  Comando de tests detectado: ${testCmd}`);
    console.log(`\n  Próximos pasos:`);
    console.log(`    1. git add .github/workflows/agentic-kdd.yml`);
    console.log(`    2. git commit -m "feat: agentic kdd ci/cd integration"`);
    console.log(`    3. git push`);
    console.log(`    4. Los fallos de CI se registrarán automáticamente en tu memoria KDD\n`);
    return true;
  } catch(e) {
    console.log(`  ✗ Error: ${e.message}`);
    return false;
  }
}

// ─── ESTADO: últimos reportes CI ────────────────────────────────────────────
function mostrarEstadoCI(db) {
  try {
    const reportes = db.all(
      `SELECT * FROM episodios WHERE area='ci-cd' ORDER BY fecha DESC LIMIT 15`
    );
    
    if (reportes.length === 0) {
      console.log('\n  Sin reportes CI registrados');
      console.log('  Instala el workflow: akdd ci-install\n');
      return;
    }
    
    console.log('\n  CI/CD — Últimos reportes en memoria KDD\n');
    reportes.forEach(r => {
      const icono = r.resultado === 'exito' ? '✅' : '❌';
      const fecha = r.fecha?.split('T')[0] || '?';
      console.log(`  ${icono} [${fecha}] ${r.descripcion?.slice(0, 100)}`);
    });
    console.log('');
  } catch(e) {
    console.log('  Error al leer reportes CI:', e.message);
  }
}

module.exports = {
  reportarCI,
  instalarWorkflow,
  mostrarEstadoCI,
  detectarEnvCI,
  parsearOutputTests,
  registrarReporteCI
};
