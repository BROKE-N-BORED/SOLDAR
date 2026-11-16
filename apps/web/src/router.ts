import { createRouter, createWebHistory } from 'vue-router';
import WorkflowList from './views/WorkflowList.vue';
import Editor from './views/Editor.vue';
import Executions from './views/Executions.vue';
import Help from './views/Help.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'workflows', component: WorkflowList },
    { path: '/workflows/:id', name: 'editor', component: Editor, props: true },
    { path: '/executions', name: 'executions', component: Executions },
    { path: '/help', name: 'help', component: Help },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
