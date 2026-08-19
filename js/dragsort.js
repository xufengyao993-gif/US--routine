/*
 * 拖拽排序：手机触摸和桌面鼠标共用一套 Pointer Events。
 *
 * 为什么不用 HTML5 drag & drop：移动端浏览器基本不支持。
 * 为什么要抓手柄才能拖：列表本身要能上下滚动，整卡片可拖会和滚动打架。
 *
 * 用法：
 *   DragSort.attach({
 *     container,               // 列表容器
 *     itemSelector: '.stop',   // 可排序的元素（容器里可以混着别的元素，会被忽略）
 *     handleSelector: '.drag-handle',
 *     onDrop: (from, to) => {} // 下标以 itemSelector 匹配到的元素为准
 *   });
 */
(function (global) {
  'use strict';

  const AUTOSCROLL_ZONE = 56;   // 离容器上下边缘多近开始自动滚
  const AUTOSCROLL_SPEED = 12;

  /** 找到真正负责滚动的那个祖先（桌面是时间轴本身，手机是整个左栏） */
  function scrollParent(el) {
    let node = el;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function attach(opts) {
    const container = opts.container;
    if (!container) return function () {};

    let drag = null;

    function onPointerDown(e) {
      const handle = e.target.closest(opts.handleSelector);
      if (!handle || !container.contains(handle)) return;
      const item = handle.closest(opts.itemSelector);
      if (!item) return;

      e.preventDefault();

      const items = Array.prototype.slice.call(container.querySelectorAll(opts.itemSelector));
      const rect = item.getBoundingClientRect();

      drag = {
        item: item,
        items: items,
        from: items.indexOf(item),
        to: items.indexOf(item),
        pointerId: e.pointerId,
        startY: e.clientY,
        offsetY: 0,
        height: rect.height,
        // 记下开始拖的时候每张卡片的中线位置，拖动过程中不再重新测量
        centers: items.map(function (el) {
          const r = el.getBoundingClientRect();
          return r.top + r.height / 2;
        }),
        placeholder: null,
        scrollTimer: null,
        scroller: scrollParent(container),
        startScroll: 0
      };
      drag.startScroll = drag.scroller.scrollTop;

      item.classList.add('is-dragging');
      item.style.width = rect.width + 'px';
      document.body.classList.add('is-dragging-active');

      const ph = document.createElement('div');
      ph.className = 'drop-indicator';
      drag.placeholder = ph;
      container.insertBefore(ph, item);

      handle.setPointerCapture(e.pointerId);
      handle.addEventListener('pointermove', onPointerMove);
      handle.addEventListener('pointerup', onPointerUp);
      handle.addEventListener('pointercancel', onPointerUp);
      drag.handle = handle;
    }

    function onPointerMove(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      e.preventDefault();

      // 自动滚动之后，开始拖时量好的位置要整体上移这么多
      const shift = drag.scroller.scrollTop - drag.startScroll;

      drag.offsetY = e.clientY - drag.startY;
      drag.item.style.transform = 'translateY(' + (drag.offsetY + shift) + 'px)';

      // 落点 = 把被拖的这张先拿掉之后，有几张卡片的中线在手指上方
      const pointerY = e.clientY;
      let target = 0;
      for (let i = 0; i < drag.centers.length; i++) {
        if (i === drag.from) continue;
        if (pointerY > drag.centers[i] - shift) target++;
      }
      if (target !== drag.to) {
        drag.to = target;
        moveIndicator(target);
      }

      autoscroll(pointerY);
    }

    function moveIndicator(target) {
      // target 是「拿掉被拖那张之后」的下标，指示线画在这个位置原本那张卡片的上方
      const rest = drag.items.filter(function (el) { return el !== drag.item; });
      const after = rest[target];
      drag.placeholder.remove();
      if (!after) {
        container.appendChild(drag.placeholder);
        return;
      }
      // 卡片上方通常还有一段路程卡片，指示线要画在它前面才对得上
      const prev = after.previousElementSibling;
      const anchor = prev && prev.classList.contains('leg') ? prev : after;
      container.insertBefore(drag.placeholder, anchor);
    }

    function autoscroll(pointerY) {
      const scroller = drag.scroller;
      const box = scroller === document.scrollingElement
        ? { top: 0, bottom: window.innerHeight }
        : scroller.getBoundingClientRect();
      let delta = 0;
      if (pointerY < box.top + AUTOSCROLL_ZONE) delta = -AUTOSCROLL_SPEED;
      else if (pointerY > box.bottom - AUTOSCROLL_ZONE) delta = AUTOSCROLL_SPEED;

      if (delta && !drag.scrollTimer) {
        drag.scrollTimer = setInterval(function () {
          scroller.scrollTop += drag.scrollDelta || 0;
        }, 16);
      }
      drag.scrollDelta = delta;
      if (!delta && drag.scrollTimer) {
        clearInterval(drag.scrollTimer);
        drag.scrollTimer = null;
      }
    }

    function onPointerUp(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const from = drag.from;
      const to = drag.to;

      if (drag.scrollTimer) clearInterval(drag.scrollTimer);
      drag.handle.removeEventListener('pointermove', onPointerMove);
      drag.handle.removeEventListener('pointerup', onPointerUp);
      drag.handle.removeEventListener('pointercancel', onPointerUp);
      if (drag.handle.hasPointerCapture && drag.handle.hasPointerCapture(e.pointerId)) {
        drag.handle.releasePointerCapture(e.pointerId);
      }

      drag.item.classList.remove('is-dragging');
      drag.item.style.transform = '';
      drag.item.style.width = '';
      if (drag.placeholder) drag.placeholder.remove();
      document.body.classList.remove('is-dragging-active');
      drag = null;

      if (from !== to && opts.onDrop) opts.onDrop(from, to);
    }

    container.addEventListener('pointerdown', onPointerDown);
    return function detach() {
      container.removeEventListener('pointerdown', onPointerDown);
    };
  }

  global.DragSort = { attach: attach };
})(window);
