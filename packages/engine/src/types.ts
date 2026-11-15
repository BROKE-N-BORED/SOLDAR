// Core types for the Soldar engine. Pure logic — no server code, no UI code.

/** One item of data flowing between nodes. Items in, items out. */
export interface Item {
  json: Record<string, unknown>;
}

/** One node in a workflow graph. */
export interface WorkflowNode {
  id: string;
  type: string;
  name: string;
  position: [number, number];
  parameters: Record<string, unknown>;
}

/** One wire between two nodes. `output` names which output of the source
 *  node the wire leaves from (default "main"). Used by branching nodes
 *  such as IF, which has "true" and "false" outputs. */
export interface Connection {
  from: string;
  to: string;
  output?: string;
}

/** Workflow-level settings. */
export interface WorkflowSettings {
  /**
   * When true, the HTTP node may call private/local addresses
   * (localhost, 192.168.x, and friends). Default false — the SSRF guard
   * blocks those calls unless the workflow opts out here.
   */
  allowPrivateAddresses?: boolean;
}

/** A workflow: one JSON document. */
export interface Workflow {
  id: string;
  name: string;
  active: boolean;
  nodes: WorkflowNode[];
  connections: Connection[];
  settings?: WorkflowSettings;
}

/** One setting a node accepts. The UI builds the settings form from these. */
export interface ParameterSchema {
  name: string;
  displayName: string;
  type:
    | 'string'
    | 'number'
    | 'boolean'
    | 'options'
    | 'json'
    | 'code'
    | 'keyValue';
  required?: boolean;
  default?: unknown;
  description?: string;
  options?: { label: string; value: string }[];
}

/** What a node returns: items per output name. Single-output nodes return
 *  `{ main: [...] }`; IF returns `{ true: [...], false: [...] }`. */
export type NodeOutput = Record<string, Item[]>;

/** What a node sees when it runs. */
export interface NodeContext {
  /** Items arriving on the wire. */
  input: Item[];
  /** The node's settings, expressions already evaluated. */
  params: Record<string, unknown>;
  /** Decrypted secret, fetched on demand. Not available in Phase 1 —
   *  the credentials store arrives in Phase 4. */
  credentials: (id: string) => Promise<unknown>;
  log: (msg: string) => void;
  /** The workflow being run (id, name, settings). */
  workflow: { id: string; name: string; settings?: WorkflowSettings };
}

/** A node definition: everything the engine and the UI need to know. */
export interface NodeDefinition {
  type: string;
  displayName: string;
  description: string;
  /** How many inputs the node takes (usually 1, 0 for triggers). */
  inputs: number;
  /** Output names, e.g. ["main"] or ["true", "false"] for IF. */
  outputs: string[];
  parameters: ParameterSchema[];
  /**
   * 'perItem' (default): execute runs once per input item, with params
   * evaluated against that item. 'allItems': execute runs once with every
   * input item (the Code node — it needs the whole list at once).
   */
  executeMode?: 'perItem' | 'allItems';
  execute: (ctx: NodeContext) => Promise<NodeOutput>;
}
