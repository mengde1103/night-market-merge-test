(() => {
  'use strict';

  const SAVE_KEY = 'night-market-merge-save-v1';
  const STATE_VERSION = 4;
  const BOARD_SIZE = 64;
  const ENERGY_INTERVAL_MS = 20_000;
  const MAX_OFFLINE_MINUTES = 240;
  const DAILY_ORDER_TARGET = 4;
  const AD_LIMITS = { energy: 3, double: 5, crate: 3 };
  const ORDER_TYPES = ['street', 'regular', 'premium'];
  const CUSTOMERS = {
    street: { name: '夜班司机', avatar: 'assets/customer-xiaolan.svg' },
    regular: { name: '下班白领', avatar: 'assets/customer-xiaolan.svg' },
    premium: { name: '校园食客', avatar: 'assets/customer-xiaolan.svg' }
  };
  const CHAINS = {
    meat: {
      label: '肉串', device: '肉类保鲜箱', deviceIcon: '🧊',
      levels: [
        null,
        { name: '鲜肉串', icon: '🥩', value: 2 },
        { name: '烤肉串', icon: '🍢', value: 5 },
        { name: '秘制肉串', icon: '🌶️', value: 12 },
        { name: '招牌肉拼盘', icon: '🍱', value: 28 },
        { name: '炭火肉宴', icon: '🥘', value: 60 }
      ]
    },
    corn: {
      label: '玉米', device: '玉米竹筐', deviceIcon: '🧺',
      levels: [
        null,
        { name: '鲜甜玉米', icon: '🌽', value: 2 },
        { name: '烤玉米', icon: '🌽', value: 6 },
        { name: '香辣玉米', icon: '🌶️', value: 14 },
        { name: '玉米拼盘', icon: '🍽️', value: 31 },
        { name: '金穗夜宵', icon: '✨', value: 66 }
      ]
    }
  };

  const $ = (selector) => document.querySelector(selector);
  const boardElement = $('#game-board');
  const toast = $('#toast');
  let toastTimer;
  let isShowingAd = false;
  let selectedIndex = null;

  function today() { return new Date().toISOString().slice(0, 10); }
  function isUnlocked(type, level = state?.stallLevel || 1) { return type === 'meat' || level >= 2; }
  function validItem(item) {
    return item && typeof item === 'object' && Object.hasOwn(CHAINS, item.type)
      && Number.isInteger(item.level) && item.level >= 1 && item.level < CHAINS[item.type].levels.length;
  }
  function makeItem(type, level = 1) { return { type, level }; }
  function itemInfo(item) { return CHAINS[item.type].levels[item.level]; }
  function itemText(item) { return `${itemInfo(item).name}，${item.level}级${CHAINS[item.type].label}`; }
  function sameItem(left, right) { return left && right && left.type === right.type && left.level === right.level; }

  function choose(values) { return values[Math.floor(Math.random() * values.length)]; }

  function createOrder(orderKind, stallLevel) {
    const options = stallLevel >= 2
      ? {
          street: [{ type: 'meat', levels: [2] }, { type: 'corn', levels: [2] }],
          regular: [{ type: 'corn', levels: [2, 3] }, { type: 'meat', levels: [2, 3] }],
          premium: [{ type: 'corn', levels: [3, 4] }, { type: 'meat', levels: [3, 4] }]
        }
      : {
          street: [{ type: 'meat', levels: [2] }],
          regular: [{ type: 'meat', levels: [2, 3] }],
          premium: [{ type: 'meat', levels: [3, 4] }]
        };
    // Level 2 introduces a guaranteed corn request in the regular slot.
    const recipe = stallLevel >= 2 && orderKind === 'regular' ? options[orderKind][0] : choose(options[orderKind]);
    const level = choose(recipe.levels);
    const multiplier = { street: 0.8, regular: 1, premium: 1.65 }[orderKind];
    const reward = Math.ceil(CHAINS[recipe.type].levels[level].value * (1 + (stallLevel - 1) * 0.15) * multiplier);
    return { orderKind, itemType: recipe.type, level, reward, boosted: false };
  }

  function freshState() {
    const now = Date.now();
    return {
      version: STATE_VERSION,
      coins: 30,
      energy: 8,
      maxEnergy: 10,
      stallLevel: 1,
      day: 1,
      board: Array(BOARD_SIZE).fill(null),
      devices: { meat: true, corn: false },
      orders: Object.fromEntries(ORDER_TYPES.map((kind) => [kind, createOrder(kind, 1)])),
      task: { date: today(), ordersCompleted: 0, claimed: false },
      adUsage: { date: today(), energy: 0, double: 0, crate: 0 },
      tutorialStep: 0,
      lastEnergyAt: now,
      lastSavedAt: now
    };
  }

  function normalizeBoard(board, version) {
    const source = Array.isArray(board) ? board : [];
    const expanded = (version === 1 && source.length === 25) || (version === 2 && source.length === 36)
      ? [...source, ...Array(BOARD_SIZE - source.length).fill(null)]
      : source;
    if (expanded.length !== BOARD_SIZE) return null;
    return expanded.map((cell) => {
      if (cell === null) return null;
      if (Number.isInteger(cell) && cell >= 1 && cell <= 5) return makeItem('meat', cell);
      return validItem(cell) ? makeItem(cell.type, cell.level) : null;
    });
  }

  function migrateState(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    const board = normalizeBoard(parsed.board, parsed.version);
    if (!board) return null;
    const stallLevel = Math.max(1, Number(parsed.stallLevel) || 1);
    const previousOrders = parsed.orders || {};
    const orders = Object.fromEntries(ORDER_TYPES.map((kind) => {
      const oldOrder = previousOrders[kind];
      if (!oldOrder || !Number.isInteger(oldOrder.level)) return [kind, createOrder(kind, stallLevel)];
      const itemType = Object.hasOwn(CHAINS, oldOrder.itemType) && isUnlocked(oldOrder.itemType, stallLevel) ? oldOrder.itemType : 'meat';
      const validLevel = oldOrder.level >= 1 && oldOrder.level <= 4 ? oldOrder.level : 2;
      const fallback = createOrder(kind, stallLevel);
      return [kind, {
        ...fallback,
        itemType,
        level: validLevel,
        reward: Math.max(1, Number(oldOrder.reward) || fallback.reward),
        boosted: Boolean(oldOrder.boosted)
      }];
    }));
    return {
      ...parsed,
      version: STATE_VERSION,
      stallLevel,
      board,
      devices: { meat: true, corn: stallLevel >= 2 },
      orders,
      tutorialStep: Math.max(0, Math.min(4, Number(parsed.tutorialStep) || 0)),
      task: parsed.task || { date: today(), ordersCompleted: 0, claimed: false },
      adUsage: parsed.adUsage || { date: today(), energy: 0, double: 0, crate: 0 }
    };
  }

  function loadState() {
    try {
      const parsed = migrateState(JSON.parse(localStorage.getItem(SAVE_KEY)));
      if (!parsed || parsed.version !== STATE_VERSION) return freshState();
      parsed.maxEnergy = 10;
      parsed.energy = Math.max(0, Math.min(parsed.maxEnergy, Number(parsed.energy) || 0));
      parsed.coins = Math.max(0, Number(parsed.coins) || 0);
      parsed.day = Math.max(1, Number(parsed.day) || 1);
      parsed.devices = { meat: true, corn: parsed.stallLevel >= 2 };
      parsed.task = parsed.task || { date: today(), ordersCompleted: 0, claimed: false };
      parsed.adUsage = { date: today(), energy: 0, double: 0, crate: 0, ...parsed.adUsage };
      parsed.lastEnergyAt = Number(parsed.lastEnergyAt) || Date.now();
      parsed.lastSavedAt = Number(parsed.lastSavedAt) || Date.now();
      return parsed;
    } catch (_) { return freshState(); }
  }

  let state = loadState();

  function saveState() {
    state.lastSavedAt = Date.now();
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); }
    catch (_) { showToast('浏览器未允许本地存储，本次进度无法保存。'); }
  }

  function resetDailyProgress() {
    if (state.adUsage.date !== today()) state.adUsage = { date: today(), energy: 0, double: 0, crate: 0 };
    if (state.task.date !== today()) {
      state.task = { date: today(), ordersCompleted: 0, claimed: false };
      state.festivalClaimed = false;
      state.day += 1;
    }
  }

  function applyEnergyRecovery() {
    if (state.energy >= state.maxEnergy) { state.lastEnergyAt = Date.now(); return; }
    const recovered = Math.floor((Date.now() - state.lastEnergyAt) / ENERGY_INTERVAL_MS);
    if (recovered > 0) {
      state.energy = Math.min(state.maxEnergy, state.energy + recovered);
      state.lastEnergyAt += recovered * ENERGY_INTERVAL_MS;
    }
  }

  function collectOfflineReward() {
    const minutes = Math.min(MAX_OFFLINE_MINUTES, Math.floor((Date.now() - state.lastSavedAt) / 60_000));
    if (minutes < 1) return;
    const reward = minutes * (2 + state.stallLevel);
    state.coins += reward;
    showToast(`夜市离线营业完成，获得 ${reward} 金币。`);
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 2500);
  }

  function announce(message) {
    $('#selection-hint').textContent = message;
    showToast(message);
  }

  function tutorialMessage() {
    return [
      '新手提示 1/5：点击肉类保鲜箱，备好两份鲜肉串。',
      '新手提示 2/5：选中两份同级鲜肉串，合成烤肉串。',
      '新手提示 3/5：把烤肉串交付给顾客，赚到升级金币。',
      '新手提示 4/5：升级到 2 级摊位，解锁烤玉米。',
      '新手提示完成：玉米竹筐已开张，肉串和玉米都能接单。'
    ][state.tutorialStep];
  }

  function advanceTutorial(step, message) {
    if (state.tutorialStep !== step) return;
    state.tutorialStep = Math.min(4, step + 1);
    saveState();
    announce(message || tutorialMessage());
  }

  function occupiedCount() { return state.board.filter(Boolean).length; }
  function firstEmptyIndex() { return state.board.findIndex((item) => item === null); }
  function upgradeCost() { return 40 * state.stallLevel; }

  function renderTask() {
    resetDailyProgress();
    const complete = state.task.ordersCompleted >= DAILY_ORDER_TARGET;
    $('#task-progress').textContent = `${Math.min(state.task.ordersCompleted, DAILY_ORDER_TARGET)} / ${DAILY_ORDER_TARGET}`;
    $('#task-fill').style.width = `${Math.min(100, state.task.ordersCompleted / DAILY_ORDER_TARGET * 100)}%`;
    $('#task-copy').textContent = state.task.claimed ? '今天的开摊补给已领取，明天继续加油。' : complete ? '任务完成！点击右侧领取 25 金币。' : `再完成 ${DAILY_ORDER_TARGET - state.task.ordersCompleted} 笔订单，领取夜市补给。`;
    const claimButton = $('#task-claim-button');
    claimButton.disabled = !complete || state.task.claimed;
    claimButton.textContent = state.task.claimed ? '已领取' : '🪙 25';
  }

  function renderStall() {
    const scene = $('#stall-scene');
    scene.className = `stall-scene level-${Math.min(3, state.stallLevel)}`;
    $('#stall-scene-title').textContent = state.stallLevel >= 3 ? '3级 · 热闹夜市档' : state.stallLevel === 2 ? '2级 · 灯串遮阳摊' : '1级 · 简易烤炉';
    $('#stall-menu-items').textContent = state.stallLevel >= 2 ? '🍢 烤肉串 · 🌽 烤玉米' : '🍢 烤肉串';
    $('#device-rack').innerHTML = ['meat', 'corn'].map((type) => {
      const chain = CHAINS[type];
      const unlocked = isUnlocked(type);
      return `<button type="button" class="device ${unlocked ? '' : 'locked'}" data-device="${type}" ${unlocked ? '' : 'disabled'}><span>${chain.deviceIcon}</span><b>${chain.device}</b><small>${unlocked ? '产出 1级食材 · 1⚡' : '2级解锁'}</small></button>`;
    }).join('');
  }

  function renderOrders() {
    const queue = $('#customer-queue');
    queue.innerHTML = ORDER_TYPES.map((key) => {
      const departing = state.departingCustomer && state.departingCustomer.key === key;
      const customer = CUSTOMERS[key];
      if (departing) return `<article class="customer is-leaving"><span class="customer-avatar"><img src="${customer.avatar}" alt="${customer.name}头像"></span><div class="customer-bubble"><b>${customer.name}</b><small>谢谢招待！+${state.departingCustomer.reward}🪙</small><i>满意离场</i></div></article>`;
      const order = state.orders[key];
      if (!order) return `<article class="customer is-arriving"><span class="customer-avatar">❔</span><div class="customer-bubble"><b>下一位食客</b><small>正在靠近摊位…</small></div></article>`;
      const item = itemInfo({ type: order.itemType, level: order.level });
      return `<article class="customer"><span class="customer-avatar"><img src="${customer.avatar}" alt="${customer.name}头像"></span><div class="customer-bubble"><b>${customer.name}</b><small>想要 ${item.name}</small><button type="button" data-order="${key}">${item.icon} 交付 · ${order.reward}🪙</button></div></article>`;
    }).join('');
  }

  function renderBoard() {
    boardElement.innerHTML = '';
    state.board.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'board-cell';
      button.setAttribute('role', 'gridcell');
      button.dataset.index = index;
      if (item === null) {
        button.classList.add('empty');
        button.setAttribute('aria-label', `第 ${index + 1} 个空格，可由保鲜箱或竹筐补货`);
        button.innerHTML = '<span class="tile-icon">＋</span><span class="tile-level">备货</span>';
      } else {
        const info = itemInfo(item);
        button.classList.add(`type-${item.type}`);
        if (selectedIndex === index) button.classList.add('selected');
        if (item.level === CHAINS[item.type].levels.length - 1) button.classList.add('max');
        button.setAttribute('aria-label', itemText(item));
        button.innerHTML = `<span class="tile-icon">${info.icon}</span><span class="tile-level">${item.level}级${item.type === 'meat' ? '肉' : '玉'}</span>`;
      }
      boardElement.append(button);
    });
    $('#board-count').textContent = `${occupiedCount()} / ${BOARD_SIZE}`;
  }

  function renderResources() {
    applyEnergyRecovery();
    resetDailyProgress();
    $('#coin-value').textContent = state.coins;
    $('#energy-value').textContent = `${state.energy}/${state.maxEnergy}`;
    $('#stall-value').textContent = state.stallLevel;
    $('#day-value').textContent = state.day;
    $('#upgrade-cost').textContent = `${upgradeCost()} 金币`;
    $('#restock-button').disabled = state.energy < 1 || firstEmptyIndex() === -1;
    $('#upgrade-button').disabled = state.coins < upgradeCost();
    for (const type of Object.keys(AD_LIMITS)) {
      const count = state.adUsage[type] || 0;
      document.querySelectorAll(`[data-ad-count="${type}"]`).forEach((target) => { target.textContent = `${count}/${AD_LIMITS[type]}`; });
      document.querySelectorAll(`[data-ad-type="${type}"]`).forEach((button) => { button.disabled = isShowingAd || count >= AD_LIMITS[type]; });
    }
  }

  function render() { renderResources(); renderTask(); renderStall(); renderOrders(); renderBoard(); renderFestival(); }

  function produce(type, targetIndex = firstEmptyIndex()) {
    applyEnergyRecovery();
    if (!isUnlocked(type)) return announce('玉米竹筐会在摊位 2 级解锁。');
    if (state.energy < 1) return announce('体力不足，等待恢复或领取夜市福利。');
    if (targetIndex === -1 || state.board[targetIndex] !== null) return announce('备货台没有空位，先合成或交付食材吧。');
    state.energy -= 1;
    state.board[targetIndex] = makeItem(type, 1);
    selectedIndex = null;
    $('#selected-icon').textContent = itemInfo(state.board[targetIndex]).icon;
    saveState();
    if (type === 'meat' && state.tutorialStep === 0) advanceTutorial(0);
    else announce(`${CHAINS[type].device}送来一份${itemInfo(state.board[targetIndex]).name}。`);
    render();
  }

  function selectCell(index) {
    const item = state.board[index];
    if (item === null) return announce('请点击上方肉类保鲜箱或玉米竹筐补货。');
    $('#selected-icon').textContent = itemInfo(item).icon;
    if (selectedIndex === null) {
      selectedIndex = index;
      announce(`已选中${itemText(item)}，再选择同类型、同等级的食材。`);
      return render();
    }
    if (selectedIndex === index) {
      selectedIndex = null;
      announce('已取消选择，可以选择其他食材。');
      return render();
    }
    const selected = state.board[selectedIndex];
    if (!sameItem(selected, item)) {
      selectedIndex = index;
      announce('类型或等级不同，已切换为当前食材。');
      return render();
    }
    if (item.level >= CHAINS[item.type].levels.length - 1) {
      selectedIndex = null;
      announce(`${itemInfo(item).name}已是当前版本的最高等级。`);
      return render();
    }
    state.board[selectedIndex] = null;
    state.board[index] = makeItem(item.type, item.level + 1);
    state.coins += item.level;
    selectedIndex = null;
    const result = state.board[index];
    $('#selected-icon').textContent = itemInfo(result).icon;
    saveState();
    if (result.type === 'meat' && result.level === 2 && state.tutorialStep === 1) advanceTutorial(1);
    else announce(`合成成功：${itemInfo(result).name}，额外获得 ${item.level} 金币。`);
    render();
  }

  function deliverOrder(key) {
    const order = state.orders[key];
    if (!order || (state.departingCustomer && state.departingCustomer.key === key)) return;
    const wanted = makeItem(order.itemType, order.level);
    const index = state.board.findIndex((item) => sameItem(item, wanted));
    if (index === -1) return announce(`还没有${itemInfo(wanted).name}，继续合成吧。`);
    state.board[index] = null;
    state.coins += order.reward;
    state.task.ordersCompleted += 1;
    state.departingCustomer = { key, reward: order.reward };
    selectedIndex = null;
    $('#selected-icon').textContent = '🪙';
    saveState();
    if (state.tutorialStep === 2) advanceTutorial(2);
    else announce(`订单完成！顾客道谢后离场，获得 ${order.reward} 金币。`);
    render();
    window.setTimeout(() => {
      if (!state.departingCustomer || state.departingCustomer.key !== key) return;
      state.orders[key] = createOrder(key, state.stallLevel);
      state.departingCustomer = null;
      saveState();
      render();
      announce('新顾客来到摊前，带来了新的点单。');
    }, 950);
  }

  function claimTaskReward() {
    if (state.task.claimed || state.task.ordersCompleted < DAILY_ORDER_TARGET) return;
    state.task.claimed = true;
    state.coins += 25;
    $('#selected-icon').textContent = '🎁';
    saveState();
    announce('领取开摊补给成功：获得 25 金币！');
    render();
  }

  function upgradeStall() {
    const cost = upgradeCost();
    if (state.coins < cost) return announce(`还差 ${cost - state.coins} 金币才能升级摊位。`);
    const previousLevel = state.stallLevel;
    state.coins -= cost;
    state.stallLevel += 1;
    state.devices.corn = state.stallLevel >= 2;
    if (previousLevel === 1) state.orders = Object.fromEntries(ORDER_TYPES.map((kind) => [kind, createOrder(kind, state.stallLevel)]));
    $('#selected-icon').textContent = state.stallLevel >= 2 ? '🌽' : '🧰';
    saveState();
    if (previousLevel === 1) {
      advanceTutorial(3, '摊位升到 2 级！遮阳棚、灯串和玉米竹筐已解锁，订单开始需要烤玉米。');
    } else announce(`摊位升到 ${state.stallLevel} 级，场景和订单奖励继续提升！`);
    render();
  }

  function completeMockAd(type) {
    if (type === 'energy') {
      state.energy = Math.min(state.maxEnergy, state.energy + 3);
      return '夜市福利到账：体力 +3！';
    }
    if (type === 'double') {
      if (state.orders.premium?.boosted) return '本张高价订单已经享受双倍奖励。';
      state.orders.premium.reward *= 2;
      state.orders.premium.boosted = true;
      return '高价订单奖励已翻倍，请尽快交付！';
    }
    const emptyIndex = firstEmptyIndex();
    if (emptyIndex === -1) return '备货台已满，无法领取烤肉串。';
    state.board[emptyIndex] = makeItem('meat', 2);
    return '福利到账：获得 1 个烤肉串！';
  }

  function watchMockAd(type) {
    resetDailyProgress();
    if (isShowingAd || state.adUsage[type] >= AD_LIMITS[type]) return;
    isShowingAd = true;
    render();
    announce('正在模拟观看激励视频…');
    window.setTimeout(() => {
      isShowingAd = false;
      const result = completeMockAd(type);
      if (result.startsWith('本张高价订单已经') || result.startsWith('备货台已满')) { announce(result); return render(); }
      state.adUsage[type] += 1;
      $('#selected-icon').textContent = '🎬';
      saveState();
      announce(result);
      render();
    }, 900);
  }

  boardElement.addEventListener('click', (event) => {
    const cell = event.target.closest('.board-cell');
    if (cell) selectCell(Number(cell.dataset.index));
  });
  document.addEventListener('click', (event) => {
    const deliver = event.target.closest('[data-order]');
    if (deliver) deliverOrder(deliver.dataset.order);
    const device = event.target.closest('[data-device]');
    if (device) produce(device.dataset.device);
    const ad = event.target.closest('[data-ad-type]');
    if (ad) watchMockAd(ad.dataset.adType);
  });
  $('#restock-button').addEventListener('click', () => produce('meat'));
  $('#upgrade-button').addEventListener('click', upgradeStall);
  $('#task-claim-button').addEventListener('click', claimTaskReward);
  $('#legacy-reset-button').addEventListener('click', () => {
    if (!window.confirm('确定清除当前浏览器中的夜市经营进度吗？')) return;
    localStorage.removeItem(SAVE_KEY);
    state = freshState();
    selectedIndex = null;
    $('#selected-icon').textContent = '🔎';
    saveState();
    announce(tutorialMessage());
    render();
  });

  function renderFestival() {
    const completed = Math.min(DAILY_ORDER_TARGET, state.task.ordersCompleted);
    const claimed = Boolean(state.festivalClaimed);
    $('#festival-progress').textContent = `${completed} / ${DAILY_ORDER_TARGET}`;
    $('#festival-fill').style.width = `${completed / DAILY_ORDER_TARGET * 100}%`;
    $('#collection-count').textContent = `${Math.min(9, completed * 2)} / 9`;
    document.querySelectorAll('.collection-grid article').forEach((card, index) => card.classList.toggle('is-collected', index < completed * 2));
    const claim = $('#festival-claim');
    claim.disabled = completed < DAILY_ORDER_TARGET || claimed;
    claim.textContent = claimed ? '赶集奖励已领取' : completed >= DAILY_ORDER_TARGET ? '领取赶集奖励：40 金币' : `完成 ${DAILY_ORDER_TARGET} 笔订单后领取 40 金币`;
    $('#map-energy').textContent = `${state.energy}/${state.maxEnergy}`;
    $('#map-coins').textContent = state.coins;
    $('#map-day').textContent = state.day;
  }

  function showScreen(name) {
    document.querySelectorAll('.screen').forEach((screen) => screen.classList.add('is-hidden'));
    const target = $(`#${name}-screen`);
    if (target) target.classList.remove('is-hidden');
    const menu = $('#game-menu-modal');
    if (menu) menu.hidden = true;
    if (name !== 'launch') render();
  }

  function claimFestivalReward() {
    if (state.festivalClaimed || state.task.ordersCompleted < DAILY_ORDER_TARGET) return;
    state.festivalClaimed = true;
    state.coins += 40;
    saveState();
    announce('赶集收集完成，获得 40 金币！');
    render();
  }

  document.querySelectorAll('[data-screen]').forEach((button) => button.addEventListener('click', () => showScreen(button.dataset.screen)));
  $('#festival-claim').addEventListener('click', claimFestivalReward);
  const gameMenu = $('#game-menu-modal');
  const openGameMenu = () => { gameMenu.hidden = false; };
  $('#open-game-menu').addEventListener('click', openGameMenu);
  $('#open-game-menu-action').addEventListener('click', openGameMenu);
  $('#close-game-menu').addEventListener('click', () => { gameMenu.hidden = true; });
  $('#menu-reset-button').addEventListener('click', () => { gameMenu.hidden = true; $('#legacy-reset-button').click(); });
  gameMenu.addEventListener('click', (event) => { if (event.target === gameMenu) gameMenu.hidden = true; });
  window.addEventListener('beforeunload', saveState);
  window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveState(); });

  collectOfflineReward();
  saveState();
  render();
  showScreen('launch');
  window.setTimeout(() => { $('#launch-progress').style.width = '100%'; }, 80);
  window.setInterval(() => { renderResources(); renderFestival(); saveState(); }, 1000);
})();
