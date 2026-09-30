// DOM 조립과 표시 형식 도우미(의존 없음).


export const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content || "";

// ---------- helpers ----------
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "text") el.textContent = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

// null·undefined·false 는 그리지 않는다(replaceChildren 은 null 을 "null" 글자로 만든다).
export function fill(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}초`;
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

export function ago(iso) {
  if (!iso) return "기록 없음";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 90) return "방금 전";
  const m = s / 60; if (m < 90) return `${Math.round(m)}분 전`;
  const hr = m / 60; if (hr < 36) return `${Math.round(hr)}시간 전`;
  return `${Math.round(hr / 24)}일 전`;
}

export function clock(iso) {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return "";
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

export const $ = (id) => document.getElementById(id);

// 확인 창 하나(app.html 의 #confirm)로 모든 확인을 묻는다. ack 가 있으면 그 문구에 체크해야 진행 버튼이 켜진다. 진행하면 true.
export function ask({ title, lines = [], ok = "계속", ack = null }) {
  const dialog = $("confirm");
  return new Promise((resolve) => {
    const box = ack ? h("input", { type: "checkbox" }) : null;
    const go = h("button", { class: "btn", value: "go", disabled: Boolean(ack) }, ok);
    if (box) box.addEventListener("change", () => { go.disabled = !box.checked; });
    fill($("confirm-form"), h("h2", { text: title }), ...lines.map((line) => h("p", { class: "small", text: line })),
      ack ? h("label", { class: "check" }, box, ack) : null,
      h("div", { class: "row" }, go, h("button", { class: "btn ghost", value: "cancel" }, "취소")));
    dialog.returnValue = "";
    dialog.onclose = () => resolve(dialog.returnValue === "go");
    dialog.showModal();
  });
}
