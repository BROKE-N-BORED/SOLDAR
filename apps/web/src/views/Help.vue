<template>
  <div class="page help">
    <h1 class="page-title">How to use Soldar</h1>

    <section class="help-section">
      <h2>What it is</h2>
      <p>
        Soldar runs small jobs for you, as a row of steps. Each step is a
        node on a canvas. You connect the nodes, press Run, and the data
        flows from one step to the next.
      </p>
    </section>

    <section class="help-section">
      <h2>Make a workflow</h2>
      <ol>
        <li>Go to Workflows and press New workflow.</li>
        <li>Drag nodes from the list on the left onto the canvas, or click one to add it.</li>
        <li>Drag from one node's right edge to another node's left edge to connect them.</li>
        <li>Click a node to change its settings on the right.</li>
        <li>Press Save. Ctrl+S saves too.</li>
      </ol>
    </section>

    <section class="help-section">
      <h2>Run it</h2>
      <p>
        Press Run in the top right. Each node lights up as it finishes: amber
        while it works, green when it is done, red if it fails. Click a node
        in the Run panel to see the data that passed through it. While a run
        is going, the Stop button ends it. To try out one node on its own,
        select it and press Run just this node in its settings.
      </p>
    </section>

    <section class="help-section">
      <h2>The nodes</h2>
      <ul>
        <li><strong>Manual Trigger.</strong> Starts the run when you press Run.</li>
        <li><strong>Schedule Trigger.</strong> Starts the run on a clock, at the times in its schedule pattern. The workflow must be Active.</li>
        <li><strong>Webhook Trigger.</strong> Starts the run when a request arrives at the workflow's own web address. The address ending is in the node's settings, and the full address is Soldar's address plus /webhook/ and that ending. The workflow must be Active.</li>
        <li><strong>Set.</strong> Adds or changes fields on the data.</li>
        <li><strong>IF.</strong> Sends the data out its true output when the check holds, and out its false output when it doesn't. Each condition is a row: a value, a comparison, and something to compare it with. Several conditions combine with AND (all must hold) or OR (any must hold).</li>
        <li><strong>Code.</strong> Runs your own JavaScript on the data, safely boxed in.</li>
        <li><strong>HTTP Request.</strong> Calls a web address and returns what came back.</li>
      </ul>
    </section>

    <section class="help-section">
      <h2>Active</h2>
      <p>
        Turn a workflow Active and it runs on its own: a Schedule Trigger
        fires at its times, and a Webhook Trigger answers requests at its
        address. Turn Active off and both stop; the workflow then only
        runs when you press Run. Active workflows pick their schedules
        back up on their own when Soldar restarts.
      </p>
    </section>

    <section class="help-section">
      <h2>Expressions</h2>
      <p>
        Any setting can hold an expression in double curly brackets. It is
        filled in from the data arriving at that node:
      </p>
      <ul>
        <li v-for="example in exprExamples" :key="example.expr">
          <code>{{ example.expr }}</code> {{ example.text }}
        </li>
      </ul>
      <p>
        Inside a Code node, the helpers are different: <code>$json</code> is
        the first item's data, <code>$input.all()</code> is every item coming
        in, and <code>$input.first()</code> is the first one.
      </p>
    </section>

    <section class="help-section">
      <h2>Keys</h2>
      <ul>
        <li><strong>Ctrl+S</strong> saves the workflow.</li>
        <li><strong>Delete</strong> removes the selected node (it asks first).</li>
        <li><strong>Esc</strong> closes a dialog without changing anything.</li>
      </ul>
    </section>

    <section class="help-section">
      <h2>Updates</h2>
      <p>
        Soldar checks for a newer version when it starts. If one is out, it
        asks before downloading anything, and the download is checked
        against its published checksum before it is installed.
      </p>
      <p>
        You are running Soldar {{ version }}.
        <button
          class="btn btn-secondary"
          type="button"
          :disabled="checking"
          @click="checkNow"
        >
          {{ checking ? 'Checking...' : 'Check for updates' }}
        </button>
      </p>
      <p v-if="checkResult" role="status">{{ checkResult }}</p>
    </section>

    <section class="help-section">
      <h2>If something goes wrong</h2>
      <p>
        A failed node turns red and says why in the Run panel. The debug log
        has the full story:
      </p>
      <p>
        <a class="btn btn-secondary" href="/api/debug-log" download="soldar-debug.log">
          Download the debug log
        </a>
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useUpdatesStore } from '../stores/updates.js';

const updates = useUpdatesStore();
const checking = ref(false);
const checkResult = ref('');

// The version comes from the update status (the server's own version);
// before it loads, the page just says the version is unknown.
const version = computed(() => updates.status?.current ?? 'unknown');

async function checkNow(): Promise<void> {
  checking.value = true;
  checkResult.value = '';
  try {
    checkResult.value = await updates.checkNow();
  } finally {
    checking.value = false;
  }
}

// The example expressions live here, not in the template: the template
// parser would read the closing brackets inside them as the end of an
// interpolation.
const exprExamples = [
  { expr: '{{ $json.name }}', text: 'means the name field of the incoming data.' },
  { expr: '{{ $json.price * 2 }}', text: 'does the maths first.' },
  { expr: '{{ $node["Greet"].json.greeting }}', text: "reads the Greet node's output." },
];
</script>
