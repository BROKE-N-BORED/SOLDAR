<template>
  <aside class="settings" aria-label="Node settings">
    <div class="settings-head">
      <div>
        <h2 class="settings-title">{{ info.displayName }}</h2>
        <p class="settings-desc">{{ info.description }}</p>
      </div>
      <button class="btn btn-icon" type="button" title="Close settings" @click="emit('close')">
        X
      </button>
    </div>

    <div class="field">
      <label class="field-label" :for="`name-${node.id}`">Name</label>
      <input
        :id="`name-${node.id}`"
        class="field-input"
        type="text"
        :value="node.name"
        @input="onNameInput(($event.target as HTMLInputElement).value)"
      />
      <p class="field-help">Each node needs its own name. Expressions use it to find this node.</p>
    </div>

    <div v-for="param in info.parameters" :key="param.name" class="field">
      <label class="field-label" :for="`${param.name}-${node.id}`">
        {{ param.displayName }}
        <span v-if="param.required" class="field-required" title="Required">*</span>
      </label>

      <input
        v-if="param.type === 'string' && !isLongText(param.name)"
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
            :value="row.value"
            @input="setKeyValueRow(param.name, index, 'value', ($event.target as HTMLInputElement).value)"
          />
          <button
            class="btn btn-icon"
            type="button"
            title="Remove this row"
            @click="removeKeyValueRow(param.name, index)"
          >
            X
          </button>
        </div>
        <button class="btn btn-secondary btn-small" type="button" @click="addKeyValueRow(param.name)">
          Add a row
        </button>
      </div>

      <p v-if="param.description" class="field-help">{{ param.description }}</p>
    </div>

    <p v-if="info.parameters.length === 0" class="settings-empty">
      This node has no settings.
    </p>

    <div class="settings-foot">
      <button class="btn btn-danger" type="button" @click="emit('remove')">
        Remove node
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { reactive, watch } from 'vue';
import type { ParameterSchema, WorkflowNode } from '@soldar/engine';
import type { NodeInfo } from '../api.js';

const props = defineProps<{
  node: WorkflowNode;
  info: NodeInfo;
}>();

const emit = defineEmits<{
  (event: 'update', parameters: Record<string, unknown>): void;
  (event: 'rename', name: string): void;
  (event: 'remove'): void;
  (event: 'close'): void;
}>();

interface KeyValueRow {
  name: string;
  value: string;
}

const values = reactive<Record<string, unknown>>({});
const jsonTexts = reactive<Record<string, string>>({});
const jsonErrors = reactive<Record<string, string>>({});

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
  for (const param of props.info.parameters) {
    const current = props.node.parameters[param.name];
    values[param.name] =
      current !== undefined ? clone(current) : defaultFor(param);
    if (param.type === 'json') {
      jsonTexts[param.name] = JSON.stringify(values[param.name] ?? [], null, 2);
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

function isLongText(name: string): boolean {
  const value = stringValue(name);
  return value.length > 60 || value.includes('\n');
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

function keyValueRows(name: string): KeyValueRow[] {
  const value = values[name];
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (entry !== null && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      return {
        name: typeof record.name === 'string' ? record.name : '',
        value: typeof record.value === 'string' ? record.value : String(record.value ?? ''),
      };
    }
    return { name: '', value: '' };
  });
}

function setKeyValueRow(
  name: string,
  index: number,
  field: 'name' | 'value',
  value: string,
): void {
  const rows = keyValueRows(name);
  if (rows[index]) rows[index][field] = value;
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
</script>
