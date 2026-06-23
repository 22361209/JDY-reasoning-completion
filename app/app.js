const features = window.JDY_FEATURES || [];
const state = {
  activeModule: "审批范围",
  activeTab: "审批范围",
  search: "",
  tabs: ["审批范围"],
};

const decisionLabel = {
  build: "要",
  simple: "简单版",
  optional: "可选",
  later: "后置",
};

const decisionWeight = {
  build: 1,
  simple: 2,
  optional: 3,
  later: 4,
};

const moduleNav = document.getElementById("moduleNav");
const tabsEl = document.getElementById("tabs");
const contentArea = document.getElementById("contentArea");
const pageTitle = document.getElementById("pageTitle");
const pageSubtitle = document.getElementById("pageSubtitle");
const globalSearch = document.getElementById("globalSearch");

function groupBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key];
    acc[value] ||= [];
    acc[value].push(item);
    return acc;
  }, {});
}

function visibleFeatures() {
  const q = state.search.trim().toLowerCase();
  return features.filter((feature) => {
    if (state.activeModule !== "审批范围" && state.activeModule !== "实施队列" && feature.module !== state.activeModule) {
      return false;
    }
    if (!q) return true;
    return [feature.module, feature.feature, feature.description, feature.approval, feature.note]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });
}

function openTab(name) {
  state.activeTab = name;
  state.activeModule = name;
  if (!state.tabs.includes(name)) state.tabs.push(name);
  render();
}

function renderNav() {
  const groups = groupBy(features, "module");
  const modules = ["审批范围", "实施队列", ...Object.keys(groups)];
  moduleNav.innerHTML = modules
    .map((module) => {
      const count = module === "审批范围" ? features.length : module === "实施队列" ? features.filter((f) => f.decision === "build" || f.decision === "simple").length : groups[module].length;
      return `<button class="module-button ${state.activeModule === module ? "active" : ""}" type="button" data-module="${module}">
        <span>${module}</span><span class="module-count">${count}</span>
      </button>`;
    })
    .join("");
  moduleNav.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => openTab(button.dataset.module));
  });
}

function renderTabs() {
  tabsEl.innerHTML = state.tabs
    .map((tab) => `<button class="tab ${state.activeTab === tab ? "active" : ""}" type="button" data-tab="${tab}">${tab}</button>`)
    .join("");
  tabsEl.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => openTab(button.dataset.tab));
  });
}

function renderCards(items) {
  if (!items.length) return `<div class="empty">没有匹配的功能。</div>`;
  return `<div class="grid">${items
    .sort((a, b) => (decisionWeight[a.decision] || 9) - (decisionWeight[b.decision] || 9) || a.module.localeCompare(b.module, "zh-CN"))
    .map(
      (feature) => `<article class="feature-card">
        <div class="feature-top">
          <h2>${feature.feature}</h2>
          <span class="badge ${feature.decision}">${decisionLabel[feature.decision] || feature.approval}</span>
        </div>
        <p>${feature.description}</p>
        <div class="meta">
          <span>${feature.module}</span>
          <span>${feature.priority}</span>
          <span>${feature.targetVersion}</span>
          <span>审批：${feature.approval}</span>
        </div>
      </article>`,
    )
    .join("")}</div>`;
}

function renderQueue() {
  const queue = features
    .filter((feature) => feature.decision === "build" || feature.decision === "simple")
    .sort((a, b) => a.priority.localeCompare(b.priority) || a.module.localeCompare(b.module, "zh-CN"));
  return `<div class="panel">
    <div class="panel-title">第一阶段实施队列</div>
    <table class="queue-table">
      <thead><tr><th>顺序</th><th>模块</th><th>功能</th><th>范围</th><th>实现口径</th></tr></thead>
      <tbody>${queue
        .map(
          (feature, index) => `<tr>
            <td>${index + 1}</td>
            <td>${feature.module}</td>
            <td>${feature.feature}</td>
            <td>${decisionLabel[feature.decision]}</td>
            <td>${feature.decision === "simple" ? "先做主流程和关键状态" : "做可运行版本，按证据补完边界"}</td>
          </tr>`,
        )
        .join("")}</tbody>
    </table>
  </div>`;
}

function renderSummary() {
  const groups = groupBy(features, "decision");
  document.getElementById("buildCount").textContent = groups.build?.length || 0;
  document.getElementById("simpleCount").textContent = groups.simple?.length || 0;
  document.getElementById("laterCount").textContent = (groups.later?.length || 0) + (groups.optional?.length || 0);
}

function renderContent() {
  if (state.activeModule === "实施队列") {
    pageTitle.textContent = "实施队列";
    pageSubtitle.textContent = "按你的审批结果和 ERP 依赖关系排序，先做底座，再做业务闭环。";
    contentArea.innerHTML = renderQueue();
    return;
  }
  if (state.activeModule === "审批范围") {
    pageTitle.textContent = "审批范围";
    pageSubtitle.textContent = "所有保留功能的总览，可用顶部搜索快速筛选。";
    contentArea.innerHTML = renderCards(visibleFeatures());
    return;
  }
  pageTitle.textContent = state.activeModule;
  pageSubtitle.textContent = "当前模块内保留的复刻功能、审批口径和优先级。";
  contentArea.innerHTML = renderCards(visibleFeatures());
}

function render() {
  renderNav();
  renderTabs();
  renderSummary();
  renderContent();
}

globalSearch.addEventListener("input", (event) => {
  state.search = event.target.value;
  renderContent();
});

document.getElementById("showScope").addEventListener("click", () => openTab("审批范围"));
document.getElementById("showBuildQueue").addEventListener("click", () => openTab("实施队列"));

render();
