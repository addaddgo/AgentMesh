import { createRouter, createWebHistory } from "vue-router";

import BoardView from "../views/BoardView.vue";
import SettingsView from "../views/SettingsView.vue";
import SkillsView from "../views/SkillsView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      name: "board",
      component: BoardView
    },
    {
      path: "/skills",
      name: "skills",
      component: SkillsView
    },
    {
      path: "/settings",
      name: "settings",
      component: SettingsView
    }
  ]
});
