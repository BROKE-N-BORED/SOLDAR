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
        in the Run panel to see the data that passed through it.
      </p>
    </section>

    <section class="help-section">
      <h2>The nodes</h2>
      <ul>
        <li><strong>Manual Trigger.</strong> Starts the run when you press Run.</li>
        <li><strong>Set.</strong> Adds or changes fields on the data.</li>
        <li><strong>IF.</strong> Sends the data left or right based on a check.</li>
        <li><strong>Code.</strong> Runs your own JavaScript on the data, safely boxed in.</li>
        <li><strong>HTTP Request.</strong> Calls a web address and returns what came back.</li>
      </ul>
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
    </section>

    <section class="help-section">
      <h2>Keys</h2>
      <ul>
        <li><strong>Ctrl+S</strong> saves the workflow.</li>
        <li><strong>Delete</strong> removes the selected node.</li>
        <li><strong>Esc</strong> closes a dialog without changing anything.</li>
      </ul>
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
// The example expressions live here, not in the template: the template
// parser would read the closing brackets inside them as the end of an
// interpolation.
const exprExamples = [
  { expr: '{{ $json.name }}', text: 'means the name field of the incoming data.' },
  { expr: '{{ $json.price * 2 }}', text: 'does the maths first.' },
  { expr: '{{ $node["Greet"].json.greeting }}', text: "reads the Greet node's output." },
];
</script>
