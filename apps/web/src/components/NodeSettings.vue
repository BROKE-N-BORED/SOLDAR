<template>
  <aside class="settings" aria-label="Node settings">
    <div class="settings-head">
      <div>
        <h2 class="settings-title">{{ info.displayName }}</h2>
        <p class="settings-desc">{{ info.description }}</p>
      </div>
      <div class="settings-head-actions">
        <button
          class="btn btn-icon"
          type="button"
          :title="collapsed ? 'Expand settings' : 'Collapse settings'"
          :aria-label="collapsed ? 'Expand settings' : 'Collapse settings'"
          @click="collapsed = !collapsed"
        >
          {{ collapsed ? '+' : '-' }}
        </button>
        <button
          class="btn btn-icon"
          type="button"
          title="Close settings"
          aria-label="Close settings"
          @click="emit('close')"
        >
          X
        </button>
      </div>
    </div>

    <template v-if="!collapsed">
      <div class="field">
        <label class="field-label" :for="`name-${node.id}`">Name</label>
        <input
          :id="`name-${node.id}`"
          class="field-input"
          type="text"
          :value="node.name"
          @input="onNameInput(($event.target as HTMLInputElement).value)"
        />
        <p v-if="nameError" class="field-error" role="alert">{{ nameError }}</p>
        <p v-else class="field-help">Each node needs its own name. Expressions use it to find this node.</p>
      </div>

      <div v-for="param in info.parameters" :key="param.name" class="field">
        <label class="field-label" :for="`${param.name}-${node.id}`">
          {{ param.displayName }}
          <span v-if="param.required" class="field-required" title="Required">*</span>
        </label>

        <input
          v-if="param.type === 'string' && !longText[param.name]"
          :id="`${param.name}-${node.id}`"
          class="field-input"
          type="text"
          :value="stringValue(param.name)"
          @input="setValue(param.name, ($event.target as HTMLInputElement).value)"
        />
        <textarea
          v-else-if="param.type === 'string'"
          :id="`${param.name}-${node.id}`"
          class="field-input field-textarea"
          rows="4"
          :value="stringValue(param.name)"
          @input="setValue(param.name, ($event.target as HTMLTextAreaElement).value)"
        />
        <input
          v-else-if="param.type === 'number'"
          :id="`${param.name}-${node.id}`"
          class="field-input"
          type="number"
          :value="numberValue(param.name)"
          @input="setNumber(param.name, ($event.target as HTMLInputElement).value, param)"
        />
        <label v-else-if="param.type === 'boolean'" class="field-toggle">
          <input
            :id="`${param.name}-${node.id}`"
            type="checkbox"
            :checked="values[param.name] === true"
            @change="setValue(param.name, ($event.target as HTMLInputElement).checked)"
          />
          <span class="toggle-track" aria-hidden="true"></span>
          <span class="toggle-label">{{ values[param.name] === true ? 'On' : 'Off' }}</span>
        </label>
        <select
          v-else-if="param.type === 'options'"
          :id="`${param.name}-${node.id}`"
          class="field-input"
          :value="stringValue(param.name)"
          @change="setValue(param.name, ($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="option in param.options ?? []"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
        <textarea
          v-else-if="param.type === 'code'"
          :id="`${param.name}-${node.id}`"
          class="field-input field-textarea field-code"
          rows="8"
          spellcheck="false"
          :value="stringValue(param.name)"
          @input="setValue(param.name, ($event.target as HTMLTextAreaElement).value)"
        />
        <ConditionBuilder
          v-else-if="param.type === 'json' && node.type === 'if' && param.name === 'conditions'"
          :model-value="values[param.name]"
          @update:model-value="setValue(param.name, $event)"
        />
        <div v-else-if="param.type === 'json'">
          <textarea
            :id="`${param.name}-${node.id}`"
            class="field-input field-textarea field-code"
            rows="6"
            spellcheck="false"
            :value="jsonTexts[param.name] ?? ''"
            @input="onJsonInput(param.name, ($event.target as HTMLTextAreaElement).value)"
          />
          <p v-if="jsonErrors[param.name]" class="field-error" role="alert">
            {{ jsonErrors[param.name] }}
          </p>
        </div>
        <div v-else-if="param.type === 'keyValue'" class="key-value">
          <div
            v-for="(row, index) in keyValueRows(param.name)"
            :key="index"
            class="key-value-row"
          >
            <input
              class="field-input"
              type="text"
              placeholder="Name"
              aria-label="Field name"
              :value="row.name"
              @input="setKeyValueRow(param.name, index, 'name', ($event.target as HTMLInputElement).value)"
            />
            <input
              class="field-input"
              type="text"
              placeholder="Value"
              aria-label="Field value"
              :value="rowText(row.value)"
              @input="setKeyValueRow(param.name, index, 'value', ($event.target as HTMLInputElement).value)"
            />
            <button
              class="btn btn-icon"
              type="button"
              title="Remove this row"
              aria-label="Remove this row"
              @click="removeKeyValueRow(param.name, index)"
            >
              X
            </button>
          </div>
          <button class="btn btn-secondary btn-small" type="button" @click="addKeyValueRow(param.name)">
            Add a row
          </button>
        </div>

        <p v-if="requiredErrors[param.name]" class="field-error" role="alert">
          {{ requiredErrors[param.name] }}
        </p>
        <p v-else-if="param.description" class="field-help">{{ param.description }}</p>
      </div>

      <p v-if="info.parameters.length === 0" class="settings-empty">
        This node has no settings.
      </p>

      <div class="field expr-help">
        <button
          class="expr-help-toggle"
          type="button"
          :aria-expanded="showExprHelp"
          @click="showExprHelp = !showExprHelp"
        >
          {{ showExprHelp ? 'Hide expression help' : exprHelpTitle }}
        </button>
        <ul v-if="showExprHelp" class="expr-help-list">
          <li v-for="example in exprExamples" :key="example.expr">
            <code>{{ example.expr }}</code> {{ example.text }}
          </li>
          <li v-if="info.type === 'code'"><code>$json</code> in Code is the first item's data.</li>
          <li v-if="info.type === 'code'"><code>$input.all()</code> and <code>$input.first()</code> read the items coming in.</li>
        </ul>
      </div>

      <div class="settings-foot">
        <button
          class="btn btn-secondary"
          type="button"
          :disabled="running"
          title="Run only this node, with one empty item"
          @click="emit('run-node')"
        >
          Run just this node
        </button>
        <button class="btn btn-danger" type="button" @click="emit('remove')">
          Remove node
        </button>
      </div>
    </template>
  </aside>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { ParameterSchema, WorkflowNode } from '@soldar/engine';
import type { NodeInfo } from '../api.js';
import ConditionBuilder from './ConditionBuilder.vue';

const props = defineProps<{
  node: WorkflowNode;
  info: NodeInfo;
  /** Names of the other nodes, for the duplicate-name warning. */
  siblingNames: string[];
  /** True while a run is going (disables Run-just-this-node). */
  running: boolean;
}>();

const emit = defineEmits<{
  (event: 'update', parameters: Record<string, unknown>): void;
  (event: 'rename', name: string): void;
  (event: 'remove'): void;
  (event: 'close'): void;
  /** False while anything in this form would fail a save or a run. */
  (event: 'validity', valid: boolean): void;
  (event: 'run-node'): void;
}>();

interface KeyValueRow {
  name: string;
  /** The raw stored value — its type is preserved, never stringified. */
  value: unknown;
}

const values = reactive<Record<string, unknown>>({});
const jsonTexts = reactive<Record<string, string>>({});
const jsonErrors = reactive<Record<string, string>>({});
// Whether each string field renders as a textarea. Decided once when the
// node is selected, from the value it starts with — never while typing,
// so the field does not swap out from under the user's fingers.
const longText = reactive<Record<string, boolean>>({});
const collapsed = ref(false);
const showExprHelp = ref(false);

// The example expressions live here, not in the template: the template
// parser would read the closing brackets inside them as the end of an
// interpolation.
const exprHelpTitle = 'What can I write in {{ }}?';
const exprExamples = [
  { expr: '{{ $json.name }}', text: 'the name field of the incoming data.' },
  { expr: '{{ $json.price * 2 }}', text: 'does the maths first.' },
  { expr: '{{ $node["Greet"].json.greeting }}', text: "reads the Greet node's output." },
];

function clone(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function defaultFor(param: ParameterSchema): unknown {
  if (param.default !== undefined) return clone(param.default);
  switch (param.type) {
    case 'string':
    case 'code':
      return '';
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'options':
      return param.options?.[0]?.value ?? '';
    case 'json':
      return [];
    case 'keyValue':
      return [];
  }
}

function reset(): void {
  for (const key of Object.keys(values)) delete values[key];
  for (const key of Object.keys(jsonTexts)) delete jsonTexts[key];
  for (const key of Object.keys(jsonErrors)) delete jsonErrors[key];
  for (const key of Object.keys(longText)) delete longText[key];
  for (const param of props.info.parameters) {
    const current = props.node.parameters[param.name];
    values[param.name] =
      current !== undefined ? clone(current) : defaultFor(param);
    if (param.type === 'json') {
      jsonTexts[param.name] = JSON.stringify(values[param.name] ?? [], null, 2);
    }
    if (param.type === 'string') {
      const text = stringValue(param.name);
      longText[param.name] = text.length > 60 || text.includes('\n');
    }
  }
}

// Only reset when a different node is selected, so typing in a field is
// never clobbered by the parent saving the same values back.
watch(
  () => props.node.id,
  () => reset(),
  { immediate: true },
);

function send(): void {
  emit('update', { ...values });
}

function setValue(name: string, value: unknown): void {
  values[name] = value;
  send();
}

function stringValue(name: string): string {
  const value = values[name];
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return String(value);
}

function numberValue(name: string): number | string {
  const value = values[name];
  return typeof value === 'number' ? value : '';
}

function setNumber(name: string, raw: string, param: ParameterSchema): void {
  if (raw === '') {
    values[name] = defaultFor(param);
  } else {
    const parsed = Number(raw);
    values[name] = Number.isFinite(parsed) ? parsed : defaultFor(param);
  }
  send();
}

function onJsonInput(name: string, text: string): void {
  jsonTexts[name] = text;
  try {
    values[name] = JSON.parse(text) as unknown;
    jsonErrors[name] = '';
    send();
  } catch {
    jsonErrors[name] = 'That is not valid JSON. Fix it before saving.';
  }
}

// The key-value rows keep their raw values: editing one row used to
// stringify every row's value, turning a number 30 into the string "30".
function keyValueRows(name: string): KeyValueRow[] {
  const value = values[name];
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (entry !== null && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      return {
        name: typeof record.name === 'string' ? record.name : '',
        value: record.value,
      };
    }
    return { name: '', value: '' };
  });
}

function rowText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Coerce typed text back to the row's previous type when it still fits. */
function coerceValue(previous: unknown, text: string): unknown {
  if (typeof previous === 'number') {
    if (text.trim() === '') return text;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : text;
  }
  if (typeof previous === 'boolean') {
    if (text === 'true') return true;
    if (text === 'false') return false;
    return text;
  }
  return text;
}

function setKeyValueRow(
  name: string,
  index: number,
  field: 'name' | 'value',
  text: string,
): void {
  const rows = keyValueRows(name);
  const row = rows[index];
  if (!row) return;
  if (field === 'name') {
    row.name = text;
  } else {
    row.value = coerceValue(row.value, text);
  }
  values[name] = rows;
  send();
}

function addKeyValueRow(name: string): void {
  values[name] = [...keyValueRows(name), { name: '', value: '' }];
  send();
}

function removeKeyValueRow(name: string, index: number): void {
  const rows = keyValueRows(name);
  rows.splice(index, 1);
  values[name] = rows;
  send();
}

function onNameInput(name: string): void {
  emit('rename', name);
}

const nameError = computed(() => {
  const name = props.node.name.trim();
  if (name === '') return 'Every node needs a name.';
  if (props.siblingNames.includes(props.node.name)) {
    return `Another node is already called "${props.node.name}". Names must be different.`;
  }
  return '';
});

const requiredErrors = computed<Record<string, string>>(() => {
  const errors: Record<string, string> = {};
  for (const param of props.info.parameters) {
    if (!param.required) continue;
    const value = values[param.name];
    if (value === undefined || value === null || value === '') {
      errors[param.name] = `This is required. Fill it in before saving.`;
    }
  }
  return errors;
});

// The form is valid when nothing in it would fail a save or a run: no
// JSON parse errors, no empty required fields, no duplicate node name.
const valid = computed(() => {
  if (nameError.value !== '') return false;
  if (Object.values(jsonErrors).some((e) => e !== '')) return false;
  return Object.keys(requiredErrors.value).length === 0;
});

watch(valid, (value) => emit('validity', value), { immediate: true });
</script>
