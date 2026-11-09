/* Markly · 组件层：统一选择器（避免浏览器原生下拉菜单在各处样式不一致） */
'use strict';

(() => {
  const openMenus = new Set();

  function close(menu) {
    menu.shell.classList.remove('is-open');
    menu.trigger.setAttribute('aria-expanded', 'false');
    openMenus.delete(menu);
  }

  function closeAll(except) {
    [...openMenus].forEach((menu) => { if (menu !== except) close(menu); });
  }

  function labelFor(option) {
    return option?.label || option?.textContent?.trim() || '请选择';
  }

  function sync(menu) {
    const { select, trigger, list } = menu;
    const selected = select.options[select.selectedIndex];
    trigger.querySelector('.select-trigger-text').textContent = labelFor(selected);
    trigger.disabled = select.disabled;
    trigger.classList.toggle('is-placeholder', !selected || !selected.value);
    list.replaceChildren();
    [...select.options].forEach((option) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'select-option';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.selected));
      item.disabled = option.disabled;
      item.tabIndex = -1;
      item.textContent = labelFor(option);
      item.addEventListener('click', () => {
        if (option.disabled) return;
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        sync(menu);
        close(menu);
        trigger.focus();
      });
      list.appendChild(item);
    });
  }

  function create(select) {
    if (select.multiple || select.dataset.selectMenu === 'ready') return;
    const shell = document.createElement('div');
    shell.className = 'select-menu';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'select-trigger';
    trigger.innerHTML = '<span class="select-trigger-text"></span><span class="select-trigger-chevron" aria-hidden="true"></span>';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const list = document.createElement('div');
    list.className = 'select-options';
    list.setAttribute('role', 'listbox');

    select.dataset.selectMenu = 'ready';
    select.classList.add('select-native');
    select.setAttribute('tabindex', '-1');
    select.setAttribute('aria-hidden', 'true');
    select.before(shell);
    shell.append(select, trigger, list);
    const menu = { select, trigger, list, shell };
    shell.menu = menu;

    trigger.addEventListener('click', () => {
      if (select.disabled) return;
      const willOpen = !shell.classList.contains('is-open');
      closeAll(menu);
      if (willOpen) {
        shell.classList.add('is-open');
        trigger.setAttribute('aria-expanded', 'true');
        openMenus.add(menu);
      } else close(menu);
    });
    trigger.addEventListener('keydown', (event) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        if (!shell.classList.contains('is-open')) trigger.click();
        const enabled = [...list.querySelectorAll('.select-option:not(:disabled)')];
        const selected = enabled.find(item => item.getAttribute('aria-selected') === 'true');
        (selected || (event.key === 'ArrowUp' ? enabled.at(-1) : enabled[0]))?.focus();
      }
    });
    shell.addEventListener('keydown', (event) => {
      if (!shell.classList.contains('is-open')) return;
      if (event.key === 'Escape') {
        // Dismiss the innermost popup, keeping the form and its unsaved input open.
        event.preventDefault(); event.stopPropagation(); close(menu); trigger.focus();
        return;
      }
      if (!list.contains(event.target)) return;
      if (event.key === 'Tab') {
        close(menu); trigger.focus(); // Let the browser move to the adjacent form field.
        return;
      }
      const options = [...list.querySelectorAll('.select-option:not(:disabled)')];
      const index = options.indexOf(event.target);
      let next;
      if (event.key === 'ArrowDown') next = options[(index + 1) % options.length];
      if (event.key === 'ArrowUp') next = options[(index - 1 + options.length) % options.length];
      if (event.key === 'Home') next = options[0];
      if (event.key === 'End') next = options.at(-1);
      if (next) { event.preventDefault(); next.focus(); }
    });
    shell.addEventListener('focusout', (event) => {
      if (!shell.contains(event.relatedTarget)) close(menu);
    });
    select.addEventListener('change', () => sync(menu));
    sync(menu);
  }

  window.enhanceSelectMenus = (root = document) => {
    const selects = root.matches?.('select') ? [root] : root.querySelectorAll?.('select') || [];
    selects.forEach(create);
  };
  window.refreshSelectMenu = (select) => {
    const menu = select?.closest('.select-menu')?.menu;
    if (menu) sync(menu);
    else if (select) create(select);
  };

  document.addEventListener('click', (event) => {
    if (![...openMenus].some((menu) => menu.shell.contains(event.target))) closeAll();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeAll(); });
  document.addEventListener('DOMContentLoaded', () => {
    window.enhanceSelectMenus();
    const observer = new MutationObserver((records) => {
      records.forEach((record) => {
        if (record.type === 'childList' && record.target instanceof HTMLSelectElement) window.refreshSelectMenu(record.target);
        record.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) window.enhanceSelectMenus(node);
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
