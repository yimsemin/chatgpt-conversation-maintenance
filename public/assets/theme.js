// 렌더링 전에 테마를 정해 깜빡임을 막는다. 로컬 저장값과 OS 설정만 본다.
try {
  const saved = localStorage.getItem("maintenance_theme");
  document.documentElement.dataset.theme = saved || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
} catch {}
