import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('INV-LEGO-21..22: catalog registers 35 runtime bricks including python_http_client and python_streamlit_ui', async () => {
    const { RUNTIME_BRICKS, listLegoBricks, getLegoBrick } = await import('./catalog.js');

    assert.equal(RUNTIME_BRICKS.length, 35);
    assert.equal(listLegoBricks().length, 35);
    assert.equal(listLegoBricks({ runtime: 'python' }).length, 10);

    const pyHttp = getLegoBrick('python_http_client');
    assert.ok(pyHttp, 'Expected python_http_client brick in catalog');
    assert.equal(pyHttp.runtime, 'python');
    assert.equal(pyHttp.importPath, 'krusch_toolkit.http_client');
    assert.deepEqual(pyHttp.exports, [
        'HttpCircuitBreaker',
        'create_http_circuit_breaker',
        'compute_retry_delay',
        'build_resilient_headers',
        'request_json',
        'async_request_json'
    ]);

    const pySt = getLegoBrick('python_streamlit_ui');
    assert.ok(pySt, 'Expected python_streamlit_ui brick in catalog');
    assert.equal(pySt.runtime, 'python');
    assert.equal(pySt.importPath, 'krusch_toolkit.streamlit_ui');
    assert.deepEqual(pySt.exports, [
        'AIRGAPPED_THEME_PRESETS',
        'build_airgapped_theme_css',
        'build_rag_auth_headers',
        'format_citation_badges_html',
        'render_citation_badges',
        'init_rag_session_state',
        'append_rag_turn',
        'render_sovereign_rag_shell'
    ]);

    for (const id of ['python_http_client', 'python_streamlit_ui']) {
        const inspectOut = execFileSync(
            process.execPath,
            [path.join(__dirname, 'bin/krusch-lego.js'), 'inspect', id, '--json'],
            { encoding: 'utf8' }
        );
        const parsed = JSON.parse(inspectOut);
        assert.equal(parsed.ok, true);
        assert.equal(parsed.data.kind, 'brick');
        assert.equal(parsed.data.brick.id, id);
    }
});

test('INV-LEGO-15 & Wave 5/6 Scout: python-httpx-resilience, streamlit-rag-shell, python-sqlalchemy-wal-pool & yaml-safe-config-loader report ALREADY_COVERED_IN_TOOLKIT', async () => {
    const { scoutHomelabLegoCandidates } = await import('./lego-scout.js');

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lego-scout-w5-'));
    try {
        // 3 source-only projects sharing SQLAlchemy engine + YAML safe_load/js-yaml + raw httpx/streamlit
        for (const [idx, name] of ['rag-one', 'rag-two', 'rag-three'].entries()) {
            const projDir = path.join(tmpRoot, name);
            fs.mkdirSync(projDir, { recursive: true });
            fs.writeFileSync(
                path.join(projDir, 'db_pool.py'),
                'from sqlalchemy import create_engine\nfrom sqlalchemy.orm import sessionmaker\nimport yaml\nengine = create_engine("sqlite:///app.db")\nSessionLocal = sessionmaker(bind=engine)\ncfg = yaml.safe_load("a: 1")\n',
                'utf8'
            );
            if (idx === 0) {
                // Adopted Wave-5 bricks MUST NOT trigger raw httpx/streamlit source detectors
                fs.writeFileSync(
                    path.join(projDir, 'adopted_ui.py'),
                    'from krusch_toolkit.http_client import async_request_json\nfrom krusch_toolkit.streamlit_ui import render_sovereign_rag_shell\n',
                    'utf8'
                );
            } else {
                fs.writeFileSync(
                    path.join(projDir, 'legacy_ui.py'),
                    'import streamlit as st\nimport httpx\nclient = httpx.AsyncClient()\n',
                    'utf8'
                );
            }
        }

        // 1 Node project using js-yaml via source import
        const nodeYamlDir = path.join(tmpRoot, 'node-pack-loader', 'src');
        fs.mkdirSync(nodeYamlDir, { recursive: true });
        fs.writeFileSync(
            path.join(nodeYamlDir, 'loader.js'),
            "import yaml from 'js-yaml';\nexport const pack = yaml.load('id: pack-1');\n",
            'utf8'
        );

        const scoutRes = scoutHomelabLegoCandidates(tmpRoot, { minProjects: 3, portablePaths: true });
        assert.equal(scoutRes.ok, true);

        const httpxCluster = scoutRes.data.candidateClusters.find((c) => c.id === 'python-httpx-resilience');
        assert.ok(httpxCluster);
        assert.equal(httpxCluster.status, 'ALREADY_COVERED_IN_TOOLKIT');
        assert.equal(httpxCluster.projects.includes('rag-one'), false, 'Project already using krusch_toolkit.http_client must not be flagged by source detector');
        assert.deepEqual(httpxCluster.projects, ['rag-three', 'rag-two']);

        const stCluster = scoutRes.data.candidateClusters.find((c) => c.id === 'streamlit-rag-shell');
        assert.ok(stCluster);
        assert.equal(stCluster.status, 'ALREADY_COVERED_IN_TOOLKIT');
        assert.equal(stCluster.projects.includes('rag-one'), false);

        const sqlaCluster = scoutRes.data.candidateClusters.find((c) => c.id === 'python-sqlalchemy-wal-pool');
        assert.ok(sqlaCluster, 'Expected python-sqlalchemy-wal-pool Wave-6 covered cluster');
        assert.equal(sqlaCluster.projectCount, 3);
        assert.equal(sqlaCluster.status, 'ALREADY_COVERED_IN_TOOLKIT');
        assert.equal(sqlaCluster.proposedBrickImport, 'krusch_toolkit.db_async');

        const yamlCluster = scoutRes.data.candidateClusters.find((c) => c.id === 'yaml-safe-config-loader');
        assert.ok(yamlCluster, 'Expected yaml-safe-config-loader Wave-6 covered cluster');
        assert.equal(yamlCluster.projectCount, 4);
        assert.equal(yamlCluster.status, 'ALREADY_COVERED_IN_TOOLKIT');
        assert.equal(yamlCluster.proposedBrickImport, '@krusch/toolkit/yaml');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});
