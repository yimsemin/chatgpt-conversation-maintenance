// 업데이트 내역: 버전 버튼을 누르면 CHANGELOG.md 의 내용을 대화 상자로 보여 준다.
import { t } from "/assets/language.js";
import { $, fill, h } from "/assets/dom.js";
import { api, fail } from "/assets/net.js";

const heading = (section) => section.version === "Unreleased" ? t("changelog.unreleased") : `v${section.version} · ${section.date}`;

function renderSection(section) {
  return [h("h3", { text: heading(section) }),
    ...section.groups.flatMap((group) => [h("p", { class: "small muted", lang: "ko", text: group.label }),
      h("ul", { lang: "ko" }, ...group.entries.map((entry) => h("li", {}, h("strong", { text: `${entry.title}. ` }), entry.body)))])];
}

export function initChangelog() {
  $("version").addEventListener("click", async () => {
    try {
      const data = await api("/changelog");
      fill($("changelog-body"), ...data.sections.flatMap(renderSection));
      $("changelog").showModal();
    } catch (error) { fail(error); }
  });
}
