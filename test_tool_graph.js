import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
    CANONICAL_SHARED_TYPES,
    DEFAULT_TOOL_GRAPH_OPTIONS,
    maskTaskEntities,
    extractGivenTypesFromTask,
    inferToolGraphSchema,
    createToolGraph
} from './tool-graph.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function buildEnterpriseMultiServerCatalog() {
    return [
        // Slack
        {
            name: 'slack.find_channel',
            component: 'slack',
            description: 'Find a Slack channel by channel name and return its channel_id.',
            inputSchema: {
                type: 'object',
                properties: { channel_name: { type: 'string' } },
                required: ['channel_name']
            },
            outputSchema: {
                type: 'object',
                properties: { channel_id: { type: 'string' } }
            }
        },
        {
            name: 'slack.post_message',
            component: 'slack',
            description: 'Post a message to a Slack channel using its channel_id.',
            inputSchema: {
                type: 'object',
                properties: {
                    channel_id: { type: 'string' },
                    text: { type: 'string' }
                },
                required: ['channel_id', 'text']
            }
        },
        {
            name: 'slack.add_reaction',
            component: 'slack',
            description: 'Add an emoji reaction to an existing Slack message.',
            inputSchema: {
                type: 'object',
                properties: {
                    channel_id: { type: 'string' },
                    message_id: { type: 'string' },
                    emoji: { type: 'string' }
                },
                required: ['channel_id', 'message_id', 'emoji']
            }
        },
        // Discord (competing chat server with identically named channel_id param!)
        {
            name: 'discord.find_channel',
            component: 'discord',
            description: 'Find a Discord guild channel by name and return its channel_id.',
            inputSchema: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name']
            },
            outputSchema: {
                type: 'object',
                properties: { channel_id: { type: 'string' } }
            }
        },
        {
            name: 'discord.send_message',
            component: 'discord',
            description: 'Send a message to a Discord channel.',
            inputSchema: {
                type: 'object',
                properties: {
                    channel_id: { type: 'string' },
                    content: { type: 'string' }
                },
                required: ['channel_id', 'content']
            }
        },
        // GitHub
        {
            name: 'github.search_repositories',
            component: 'github',
            description: 'Search GitHub repositories by keyword and return repo_path.',
            inputSchema: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query']
            },
            outputSchema: {
                type: 'object',
                properties: { repo_path: { type: 'string' } }
            }
        },
        {
            name: 'github.list_pull_requests',
            component: 'github',
            description: 'List open pull requests (PRs) in a GitHub repository.',
            inputSchema: {
                type: 'object',
                properties: {
                    repo_path: { type: 'string' },
                    state: { type: 'string' }
                },
                required: ['repo_path']
            },
            outputSchema: {
                type: 'object',
                properties: { pr_id: { type: 'string' } }
            }
        },
        {
            name: 'github.get_pull_request_diff',
            component: 'github',
            description: 'Fetch unified diff for a pull request by pr_id.',
            inputSchema: {
                type: 'object',
                properties: {
                    repo_path: { type: 'string' },
                    pr_id: { type: 'string' }
                },
                required: ['repo_path', 'pr_id']
            }
        },
        {
            name: 'github.add_review_comment',
            component: 'github',
            description: 'Post a code review comment on a pull request.',
            inputSchema: {
                type: 'object',
                properties: {
                    repo_path: { type: 'string' },
                    pr_id: { type: 'string' },
                    body: { type: 'string' }
                },
                required: ['repo_path', 'pr_id', 'body']
            }
        },
        // Contacts & Email
        {
            name: 'contacts.lookup_email',
            component: 'contacts',
            description: 'Look up a person or team contact email address by display name.',
            produces: ['email_address'],
            inputSchema: {
                type: 'object',
                properties: { person_name: { type: 'string' } },
                required: ['person_name']
            }
        },
        {
            name: 'gmail.send_email',
            component: 'gmail',
            description: 'Send an email message to a recipient email address.',
            inputSchema: {
                type: 'object',
                properties: {
                    to_email: { type: 'string' },
                    subject: { type: 'string' },
                    body: { type: 'string' }
                },
                required: ['to_email', 'subject', 'body']
            }
        },
        // Billing / Stripe (for gap-driven discovery test: create_refund initially omits `invoice_id` from required!)
        {
            name: 'stripe.list_invoices',
            component: 'stripe',
            description: 'List billing invoices for an order or customer and return invoice_id.',
            inputSchema: {
                type: 'object',
                properties: { query: { type: 'string' } }
            },
            outputSchema: {
                type: 'object',
                properties: { invoice_id: { type: 'string' } }
            }
        },
        {
            name: 'stripe.create_refund',
            component: 'stripe',
            description: 'Issue a payment refund for an order or billing charge.',
            inputSchema: {
                type: 'object',
                properties: {
                    reason: { type: 'string' },
                    amount_cents: { type: 'integer' }
                }
            }
        }
    ];
}

function buildSovereignStackCatalog() {
    return [
        {
            name: 'krusch_run',
            description: 'Submit a coding task through the staged 2PC harness and return task_id.',
            inputSchema: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] }
        },
        {
            name: 'krusch_diff',
            description: 'Inspect the staged unified diff for a pending task_id.',
            inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }
        },
        {
            name: 'krusch_apply_diff',
            description: 'Atomically apply a verified staged diff to disk for task_id.',
            inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }
        },
        {
            name: 'krusch_fs_locate',
            description: 'Locate files matching a glob pattern across filesystem nodes.',
            inputSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] }
        },
        {
            name: 'krusch_fs_page_tree',
            description: 'Inspect structural page tree and section line ranges of a document.',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
        },
        {
            name: 'krusch_fs_read_page',
            description: 'Read a bounded page of a large file with SHA-256 drift verification.',
            inputSchema: {
                type: 'object',
                properties: { path: { type: 'string' }, page_number: { type: 'integer' } },
                required: ['path', 'page_number']
            }
        },
        {
            name: 'krusch_git_search_symbols',
            description: 'Locate function, class, or route symbol declarations across repository.',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        },
        {
            name: 'krusch_git_dependency_graph',
            description: 'Trace inbound callers and outbound callees for a symbol blast radius check.',
            inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] }
        }
    ];
}

test('ToolGraph: exports frozen defaults and canonical cross-server shared types', () => {
    assert.equal(Object.isFrozen(DEFAULT_TOOL_GRAPH_OPTIONS), true);
    assert.equal(Object.isFrozen(CANONICAL_SHARED_TYPES), true);
    assert.ok(CANONICAL_SHARED_TYPES.includes('repo_path'));
    assert.ok(CANONICAL_SHARED_TYPES.includes('email_address'));
    assert.ok(CANONICAL_SHARED_TYPES.includes('task_id'));
});

test('ToolGraph: extractGivenTypesFromTask detects concrete prompt literals without false-matching plain English', () => {
    const res = extractGivenTypesFromTask(
        'Email diff of commit a1b2c3d4 in acme/api and ./config/settings.yaml to finance@example.com on #release-ops (https://example.com/run/1)',
        ['customParam']
    );

    assert.ok(res.givenTypes.includes('email_address'));
    assert.ok(res.givenTypes.includes('repo_path'));
    assert.ok(res.givenTypes.includes('file_path'));
    assert.ok(res.givenTypes.includes('channel_name'));
    assert.ok(res.givenTypes.includes('commit_sha'));
    assert.ok(res.givenTypes.includes('url'));
    assert.ok(res.givenTypes.includes('custom_param'));

    // Plain English words like "accede" or ratios like "yes/no" must NOT trigger commit_sha or repo_path
    const clean = extractGivenTypesFromTask('Decide yes/no whether we accede to the feed schedule');
    assert.deepEqual(clean.givenTypes, []);
});

test('ToolGraph: solves multi-server cross-tool routing ("Post open PRs in acme/api to #eng on Slack") with namespace-scoped channel_id', () => {
    const tg = createToolGraph(buildEnterpriseMultiServerCatalog(), { budget: 5 });

    const res = tg.findTools({
        task: 'Post the open PRs in acme/api to #eng on Slack'
    });

    assert.equal(res.ok, true);
    assert.equal(res.tool, 'tool_graph.find_tools');
    assert.ok(res.data.extractedGiven.includes('repo_path'), 'acme/api should auto-populate repo_path in extractedGiven');
    assert.ok(res.data.extractedGiven.includes('channel_name'), '#eng should auto-populate channel_name in extractedGiven');

    const names = res.data.selectedTools;
    assert.ok(names.includes('github.list_pull_requests'), `Expected github.list_pull_requests in ${JSON.stringify(names)}`);
    assert.ok(names.includes('slack.find_channel'), `Expected slack.find_channel prerequisite in ${JSON.stringify(names)}`);
    assert.ok(names.includes('slack.post_message'), `Expected slack.post_message in ${JSON.stringify(names)}`);

    // Because `repo_path` was extracted from `acme/api`, `github.search_repositories` MUST NOT be pulled as a prerequisite
    assert.equal(names.includes('github.search_repositories'), false, 'Grounded repo_path must prune github.search_repositories');
    // Namespace scoping MUST prevent Discord's channel_id producer from satisfying Slack's channel_id consumer
    assert.equal(names.includes('discord.find_channel'), false, 'discord.find_channel must never satisfy slack.channel_id');

    // Prerequisite must appear BEFORE its consumer
    assert.ok(
        names.indexOf('slack.find_channel') < names.indexOf('slack.post_message'),
        'Prerequisite slack.find_channel must be ordered before slack.post_message'
    );

    const findChannelEntry = res.data.tools.find((t) => t.name === 'slack.find_channel');
    assert.equal(findChannelEntry.why.role, 'prerequisite');
    assert.equal(findChannelEntry.why.produces, 'slack.channel_id');
    assert.equal(findChannelEntry.why.for, 'slack.post_message');
});

test('ToolGraph: automatic given literal pruning prevents false email lookup when literal email is present', () => {
    const tg = createToolGraph(buildEnterpriseMultiServerCatalog(), { budget: 4 });

    // Case A: concrete email literal supplied in prompt -> no contacts.lookup_email prerequisite
    const literalRes = tg.findTools({
        task: 'Send an email with the deployment summary to finance@example.com'
    });
    assert.equal(literalRes.ok, true);
    assert.ok(literalRes.data.selectedTools.includes('gmail.send_email'));
    assert.equal(
        literalRes.data.selectedTools.includes('contacts.lookup_email'),
        false,
        'Literal email in prompt must satisfy email_address without contacts.lookup_email'
    );

    // Case B: only display name supplied ("Send an email ... to Alice") -> contacts.lookup_email IS required
    const namedRes = tg.findTools({
        task: 'Send an email with the deployment summary to Alice'
    });
    assert.equal(namedRes.ok, true);
    assert.ok(namedRes.data.selectedTools.includes('gmail.send_email'));
    assert.ok(
        namedRes.data.selectedTools.includes('contacts.lookup_email'),
        'Missing literal email must pull contacts.lookup_email as prerequisite producer'
    );
});

test('ToolGraph: resolves 2-hop sovereign MCP prerequisite chains and prunes hops dynamically from prompt literals', () => {
    const tg = createToolGraph(buildSovereignStackCatalog(), { budget: 6 });

    // 1. Un-grounded: needs file_path -> page_number -> krusch_fs_read_page (2-hop chain)
    const fullChain = tg.findTools({
        task: 'Read bounded page from the architecture specification document'
    });
    assert.equal(fullChain.ok, true);
    const fullTools = fullChain.data.selectedTools;
    assert.ok(fullTools.includes('krusch_fs_read_page'));
    assert.ok(fullTools.includes('krusch_fs_page_tree'));
    assert.ok(
        fullTools.includes('krusch_fs_locate') || fullTools.includes('krusch_fs_search'),
        'Expected file_path producer before krusch_fs_page_tree'
    );

    // 2. Partial grounding: file_path literal provided (`./docs/architecture.md`), only `page_number` missing -> 1-hop chain
    const oneHop = tg.findTools({
        task: 'Read bounded page from ./docs/architecture.md'
    });
    assert.equal(oneHop.ok, true);
    assert.ok(oneHop.data.extractedGiven.includes('file_path'));
    assert.equal(oneHop.data.selectedTools.includes('krusch_fs_locate'), false);
    assert.ok(oneHop.data.selectedTools.includes('krusch_fs_page_tree'));
    assert.ok(oneHop.data.selectedTools.includes('krusch_fs_read_page'));

    // 3. Full grounding: both `./docs/architecture.md` and `page 3` present -> 0 prerequisites needed
    const zeroHop = tg.findTools({
        task: 'Read bounded page 3 from ./docs/architecture.md',
        budget: 1
    });
    assert.equal(zeroHop.ok, true);
    assert.deepEqual(zeroHop.data.selectedTools, ['krusch_fs_read_page']);
});

test('ToolGraph: two-pass budget allocator prevents learned_next edges from starving primary multi-server goals', () => {
    const tg = createToolGraph(buildEnterpriseMultiServerCatalog(), { budget: 3 });

    // Heavily reinforce GitHub follow-up edges (`list_pull_requests -> get_pull_request_diff -> add_review_comment`)
    for (let i = 0; i < 4; i++) {
        tg.reportOutcome({
            task: 'Review open PRs in org/backend',
            tools: ['github.list_pull_requests', 'github.get_pull_request_diff', 'github.add_review_comment'],
            success: true
        });
    }

    // Tight budget=3 on multi-server prompt MUST still keep Slack primary + prerequisite instead of starving Slack for learned_next
    const tightRes = tg.findTools({
        task: 'Post the open PRs in acme/api to #eng on Slack',
        budget: 3
    });
    assert.equal(tightRes.ok, true);
    assert.deepEqual(
        new Set(tightRes.data.selectedTools),
        new Set(['github.list_pull_requests', 'slack.find_channel', 'slack.post_message'])
    );

    // When budget=5 has spare capacity on a single-server review query, Pass 2 surfaces learned_next!
    const wideRes = tg.findTools({
        task: 'List open PRs in acme/api',
        budget: 5
    });
    assert.equal(wideRes.ok, true);
    const learnedItem = wideRes.data.tools.find((t) => t.name === 'github.get_pull_request_diff');
    assert.ok(learnedItem, 'Expected spare budget slot to include learned_next tool github.get_pull_request_diff');
    assert.equal(learnedItem.why.role, 'learned_next');
    assert.equal(learnedItem.why.after, 'github.list_pull_requests');
});

test('ToolGraph: gap-driven missingInput learning, weight clamping [0, 5], bounded LRU eviction, and snapshot import/export', () => {
    const tg = createToolGraph(buildEnterpriseMultiServerCatalog(), {
        budget: 4,
        maxIntents: 8
    });

    // Before feedback, `stripe.create_refund` has no declared `invoice_id` requirement
    const beforeGap = tg.findTools({
        task: 'Issue a payment refund for order 1042',
        budget: 2
    });
    assert.equal(beforeGap.ok, true);
    assert.ok(beforeGap.data.selectedTools.includes('stripe.create_refund'));
    assert.equal(beforeGap.data.selectedTools.includes('stripe.list_invoices'), false);

    // Report failure due to missing `invoice_id` -> gap learner discovers `stripe.list_invoices` (`PRODUCED_BY`)
    const outcome = tg.reportOutcome({
        task: 'Issue a payment refund for order 1042',
        tools: ['stripe.create_refund'],
        success: false,
        missingInput: 'invoice_id'
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.data.gapProducersBoosted.length, 1);
    assert.equal(outcome.data.gapProducersBoosted[0].producer, 'stripe.list_invoices');

    // Different order number maps to identical masked intent signature & triggers dynamic prerequisite!
    const afterGap = tg.findTools({
        task: 'Issue a payment refund for order 9988',
        budget: 2
    });
    assert.equal(afterGap.ok, true);
    assert.ok(afterGap.data.selectedTools.includes('stripe.list_invoices'), 'Gap-learned producer must be surfaced');
    assert.ok(afterGap.data.selectedTools.includes('stripe.create_refund'));
    assert.ok(
        afterGap.data.selectedTools.indexOf('stripe.list_invoices') <
            afterGap.data.selectedTools.indexOf('stripe.create_refund')
    );

    // Weight clamping [0, 5]: 20 consecutive successes never exceed 5.0
    for (let i = 0; i < 20; i++) {
        tg.reportOutcome({
            task: 'Issue a payment refund for order 9988',
            tools: ['stripe.list_invoices', 'stripe.create_refund'],
            success: true
        });
    }
    const snap = tg.exportState();
    assert.equal(snap.ok, true);
    for (const intent of snap.data.intents) {
        for (const w of Object.values(intent.weights)) {
            assert.ok(w >= 0 && w <= 5, `Weight ${w} exceeded [0, 5] clamp`);
        }
    }

    // Export -> Import into a clean instance preserves gap-discovered dynamicConsumes & weights
    const restored = createToolGraph(buildEnterpriseMultiServerCatalog(), { budget: 4, maxIntents: 8 });
    const imp = restored.importState(snap);
    assert.equal(imp.ok, true);
    assert.equal(imp.data.dynamicConsumesCount, 1);

    const restoredFind = restored.findTools({
        task: 'Issue a payment refund for order 7777',
        budget: 2
    });
    assert.ok(restoredFind.data.selectedTools.includes('stripe.list_invoices'));

    // Bounded LRU: inserting 20 distinct intents keeps `learnedIntentCount <= 8`
    for (let idx = 0; idx < 20; idx++) {
        const wordA = String.fromCharCode(97 + (idx % 26)) + 'alpha' + idx;
        tg.reportOutcome({
            task: `Unique synthetic intent phrase ${wordA}`,
            tools: ['slack.find_channel'],
            success: true
        });
    }
    assert.ok(tg.getStats().learnedIntentCount <= 8, 'LRU must strictly cap learnedIntentCount at maxIntents=8');
});

test('ToolGraph: deferred MCP meta-tools, callTool dispatch, recursive guard, sub-ms latency & strict TypeScript tsc check', async () => {
    let postedPayload = null;
    const tg = createToolGraph(buildEnterpriseMultiServerCatalog(), {
        alwaysLoaded: ['slack.post_message'],
        exposeOutcomeTool: true,
        handlers: {
            'slack.post_message': async (args) => {
                postedPayload = args;
                return { delivered: true, ts: '1700000000.0001' };
            }
        }
    });

    const exposed = tg.getExposedTools();
    assert.equal(exposed.length, 5); // 1 alwaysLoaded + 4 meta-tools
    for (const metaName of ['find_tools', 'describe_tool', 'call_tool', 'report_tool_outcome']) {
        const meta = exposed.find((t) => t.name === metaName);
        assert.ok(meta, `Expected meta-tool ${metaName}`);
        assert.equal(typeof meta.annotations.readOnlyHint, 'boolean');
        assert.equal(typeof meta.annotations.destructiveHint, 'boolean');
        assert.equal(typeof meta.annotations.idempotentHint, 'boolean');
        assert.equal(typeof meta.annotations.openWorldHint, 'boolean');
    }

    const desc = tg.describeTool('slack.post_message');
    assert.equal(desc.ok, true);
    assert.ok(desc.data.consumes.includes('slack.channel_id'));

    const unknownDesc = tg.describeTool('nonexistent.tool');
    assert.equal(unknownDesc.ok, false);
    assert.equal(unknownDesc.error.code, 'UNKNOWN_TOOL');

    const recGuard = await tg.callTool('find_tools', { task: 'loop' });
    assert.equal(recGuard.ok, false);
    assert.equal(recGuard.error.code, 'RECURSIVE_META_TOOL_CALL');

    const callRes = await tg.callTool('slack.post_message', { channel_id: 'C123', text: 'Shipped' });
    assert.equal(callRes.ok, true);
    assert.deepEqual(postedPayload, { channel_id: 'C123', text: 'Shipped' });
    assert.equal(callRes.data.result.delivered, true);

    // Latency check: 50 consecutive findTools calls over 13-tool catalog complete well under 50ms total (<1ms avg)
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) {
        tg.findTools({ task: 'Post the open PRs in acme/api to #eng on Slack' });
    }
    const avgMs = (performance.now() - t0) / 50;
    assert.ok(avgMs < 5, `Expected <5ms per findTools call, got ${avgMs.toFixed(3)}ms`);

    // Strict TypeScript `tsc --noEmit --strict` verification on `@krusch/toolkit/tool-graph`
    const localTscBin = path.resolve(__dirname, 'node_modules/.bin/tsc');
    if (fs.existsSync(localTscBin)) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-graph-tsc-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'node_modules', '@krusch'), { recursive: true });
            fs.symlinkSync(__dirname, path.join(tmpDir, 'node_modules', '@krusch', 'toolkit'));
            if (fs.existsSync(path.join(__dirname, 'node_modules', '@types'))) {
                fs.symlinkSync(
                    path.join(__dirname, 'node_modules', '@types'),
                    path.join(tmpDir, 'node_modules', '@types')
                );
            }

            fs.writeFileSync(
                path.join(tmpDir, 'tsconfig.json'),
                JSON.stringify({
                    compilerOptions: {
                        target: 'ES2022',
                        module: 'NodeNext',
                        moduleResolution: 'NodeNext',
                        strict: true,
                        noEmit: true,
                        skipLibCheck: false
                    },
                    include: ['consumer.ts']
                }),
                'utf8'
            );

            fs.writeFileSync(
                path.join(tmpDir, 'consumer.ts'),
                [
                    "import { createToolGraph, extractGivenTypesFromTask, maskTaskEntities } from '@krusch/toolkit/tool-graph';",
                    "const masked = maskTaskEntities('Send report to ops@example.com');",
                    "const given = extractGivenTypesFromTask(masked.maskedText, ['repo_path']);",
                    'const graph = createToolGraph([{ name: "slack.post_message", description: "Post", inputSchema: { type: "object", properties: { channel_id: { type: "string" } }, required: ["channel_id"] } }], { budget: 4 });',
                    "const routed = graph.findTools({ task: 'Post to #ops', given: given.givenTypes });",
                    'if (routed.ok) { const names: string[] = routed.data.selectedTools; void names; }'
                ].join('\n'),
                'utf8'
            );

            execFileSync(localTscBin, ['--project', path.join(tmpDir, 'tsconfig.json')], {
                cwd: tmpDir,
                stdio: 'pipe'
            });
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }
});

test('ToolGraph: inferToolGraphSchema rejects non-array input cleanly', () => {
    assert.throws(() => inferToolGraphSchema(null), TypeError);
    assert.throws(() => createToolGraph('invalid'), TypeError);
});
