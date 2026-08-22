(function () {
  'use strict';

  var STORAGE_KEY = 'todo.tasks.v1';

  var listEl = document.getElementById('list');
  var emptyEl = document.getElementById('empty');
  var countEl = document.getElementById('count');
  var formEl = document.getElementById('composer');
  var inputEl = document.getElementById('new-task');
  var clearDoneEl = document.getElementById('clear-done');
  var filterEls = document.querySelectorAll('.filters__btn');

  var tasks = load();
  var filter = 'all';

  var EMPTY_MESSAGE = {
    all: 'Nothing here yet. Add your first task above.',
    active: 'No active tasks — all done.',
    done: 'No completed tasks yet.'
  };

  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!Array.isArray(raw)) return [];
      // Drop anything that doesn't look like a task, so one bad entry
      // can't break rendering.
      return raw
        .filter(function (t) { return t && typeof t.text === 'string'; })
        .map(function (t) {
          return { id: String(t.id || newId()), text: t.text, done: !!t.done };
        });
    } catch (err) {
      return [];
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch (err) {
      // Storage can be full or blocked (private mode). The app still
      // works for this session, so there's nothing to do but carry on.
    }
  }

  function newId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function visibleTasks() {
    if (filter === 'active') return tasks.filter(function (t) { return !t.done; });
    if (filter === 'done') return tasks.filter(function (t) { return t.done; });
    return tasks;
  }

  function findTask(id) {
    return tasks.filter(function (t) { return t.id === id; })[0];
  }

  function addTask(text) {
    tasks.unshift({ id: newId(), text: text, done: false });
    save();
    render();
  }

  function toggleTask(id) {
    var task = findTask(id);
    if (!task) return;
    task.done = !task.done;
    save();
    render();
  }

  function deleteTask(id) {
    tasks = tasks.filter(function (t) { return t.id !== id; });
    save();
    render();
  }

  // Editing happens in place, so the DOM already shows the new text. Only the
  // labels need patching — a full re-render here would pull the list out from
  // under a click that is still being dispatched (e.g. edit, then hit delete).
  function renameTask(id, text) {
    var task = findTask(id);
    if (!task) return;
    if (!text) {
      deleteTask(id);
      return;
    }
    if (task.text === text) return;
    task.text = text;
    save();

    var li = listEl.querySelector('[data-id="' + id + '"]');
    if (!li) return;
    li.querySelector('.task__check').setAttribute('aria-label', 'Mark "' + text + '" as done');
    li.querySelector('.task__delete').setAttribute('aria-label', 'Delete "' + text + '"');
  }

  function buildTask(task) {
    var li = document.createElement('li');
    li.className = 'task' + (task.done ? ' is-done' : '');
    li.dataset.id = task.id;

    var check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'task__check';
    check.checked = task.done;
    check.setAttribute('aria-label', 'Mark "' + task.text + '" as done');

    var text = document.createElement('span');
    text.className = 'task__text';
    text.textContent = task.text;
    text.contentEditable = 'true';
    text.spellcheck = false;
    text.title = 'Click to edit';

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'task__delete';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Delete "' + task.text + '"');

    li.appendChild(check);
    li.appendChild(text);
    li.appendChild(del);
    return li;
  }

  function render() {
    var shown = visibleTasks();

    listEl.textContent = '';
    shown.forEach(function (task) {
      listEl.appendChild(buildTask(task));
    });

    emptyEl.textContent = EMPTY_MESSAGE[filter];
    emptyEl.hidden = shown.length > 0;

    var left = tasks.filter(function (t) { return !t.done; }).length;
    if (tasks.length === 0) {
      countEl.textContent = 'No tasks yet';
    } else {
      countEl.textContent = left + (left === 1 ? ' task left' : ' tasks left');
    }

    clearDoneEl.hidden = tasks.length === left;
  }

  formEl.addEventListener('submit', function (event) {
    event.preventDefault();
    var text = inputEl.value.trim();
    if (!text) return;
    addTask(text);
    inputEl.value = '';
    inputEl.focus();
  });

  listEl.addEventListener('change', function (event) {
    if (!event.target.classList.contains('task__check')) return;
    toggleTask(event.target.closest('.task').dataset.id);
  });

  listEl.addEventListener('click', function (event) {
    if (!event.target.classList.contains('task__delete')) return;
    deleteTask(event.target.closest('.task').dataset.id);
  });

  // Commit an inline edit when the field loses focus...
  listEl.addEventListener('focusout', function (event) {
    if (!event.target.classList.contains('task__text')) return;
    renameTask(event.target.closest('.task').dataset.id, event.target.textContent.trim());
  }, true);

  // ...or on Enter. Escape restores the stored text before blurring.
  listEl.addEventListener('keydown', function (event) {
    if (!event.target.classList.contains('task__text')) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.target.blur();
    } else if (event.key === 'Escape') {
      var task = findTask(event.target.closest('.task').dataset.id);
      if (task) event.target.textContent = task.text;
      event.target.blur();
    }
  });

  clearDoneEl.addEventListener('click', function () {
    tasks = tasks.filter(function (t) { return !t.done; });
    save();
    render();
  });

  Array.prototype.forEach.call(filterEls, function (btn) {
    btn.addEventListener('click', function () {
      filter = btn.dataset.filter;
      Array.prototype.forEach.call(filterEls, function (other) {
        other.classList.toggle('is-active', other === btn);
      });
      render();
    });
  });

  render();
})();
