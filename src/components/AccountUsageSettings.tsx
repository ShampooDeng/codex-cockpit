import { useState } from "react";
import { accountUsageAt, addAccountUsageDeclaration, validDeclarationDate, type AccountUsageContext, type AccountUsageDeclaration } from "../lib/accountUsage";
import { localDateKey } from "../lib/comfortFeedback";
import type { TokeiUsage } from "../lib/tokeiUsage";

export function AccountUsageSettings({ context, data, personId, zh, onChange }: {
  context: AccountUsageContext; data: TokeiUsage | null; personId: string | null; zh: boolean;
  onChange: (declarations: AccountUsageDeclaration[]) => void;
}) {
  const today = localDateKey(new Date());
  const current = accountUsageAt(context, today);
  const [mode, setMode] = useState<AccountUsageDeclaration["mode"]>(current?.mode ?? "unconfirmed");
  const [from, setFrom] = useState(today);
  const [historical, setHistorical] = useState(false);
  const [error, setError] = useState(false);
  const person = data?.groups.find(group => group.id === personId);
  const labels = zh ? { exclusive: "仅我使用", shared: "多人共用", unconfirmed: "未确认" } : { exclusive: "Only me", shared: "Shared account", unconfirmed: "Unconfirmed" };
  const entries = context.declarations.filter(item => item.scope === context.scope).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  const valid = context.scope && person && validDeclarationDate(from) && from <= today && (from === today || historical);
  function save() {
    if (!valid || !context.scope || !person) return;
    try {
      onChange(addAccountUsageDeclaration(context.declarations, { scope: context.scope, mode, personId: person.id, effectiveFrom: from, declaredAt: new Date().toISOString() }));
      setError(false);
    } catch { setError(true); }
  }
  return <details className="comfort-account-settings">
    <summary>{zh ? "账号使用方式" : "Account usage"} · {labels[current?.mode ?? "unconfirmed"]}</summary>
    <p>{zh ? `当前本人：${person?.name ?? "请先选择成员"}。仅本人使用时，可直接用账号额度记录绘制此人的曲线，无需成本数据。` : `Selected person: ${person?.name ?? "select a member"}. A personal account can use recorded quota directly, without cost data.`}</p>
    <label>{zh ? "使用方式" : "Usage mode"}<select aria-label={zh ? "账号使用方式" : "Account usage mode"} value={mode} onChange={event => setMode(event.target.value as AccountUsageDeclaration["mode"])}>
      {(["unconfirmed", "exclusive", "shared"] as const).map(value => <option key={value} value={value}>{labels[value]}</option>)}
    </select></label>
    <label>{zh ? "生效日期" : "Effective date"}<input type="date" max={today} aria-label={zh ? "生效日期" : "Effective date"} value={from} onChange={event => { setFrom(event.target.value); setHistorical(false); }} /></label>
    {from < today && <label><input type="checkbox" checked={historical} onChange={event => setHistorical(event.target.checked)} />{zh ? "也应用到所选历史日期起的记录" : "Also apply to records from this past date"}</label>}
    <p>{zh ? "仅在本机生效，持续至下一条设置的生效日期。同一天重新保存会替换该日的选择，其他日期保留。" : "Applies locally until the next dated setting. Saving the same date replaces that boundary; other dates are retained."}</p>
    <p>{zh ? "此设置无法自动确认是否切换了登录账号。切换账号后，请先改为“未确认”并重新选择适用成员和日期。" : "This setting cannot detect every sign-in change. After switching accounts, reset it to Unconfirmed and confirm the person and dates again."}</p>
    {!context.scope && <p role="status">{zh ? "正在读取本机配置范围，暂不能保存使用方式。" : "Local configuration scope is unavailable; this setting cannot be saved yet."}</p>}
    <button type="button" disabled={!valid} onClick={save}>{zh ? "应用使用方式" : "Apply account usage"}</button>
    {error && <p role="alert">{zh ? "无法保存使用方式，请检查日期或设置数量。" : "Cannot save this declaration; check the date or setting count."}</p>}
    {entries.length > 0 && <ul aria-label={zh ? "使用方式历史" : "Account usage history"}>{entries.map(item => <li key={item.effectiveFrom}>{item.effectiveFrom} · {labels[item.mode]} · {data?.groups.find(group => group.id === item.personId)?.name ?? (zh ? "历史成员" : "Former member")}</li>)}</ul>}
  </details>;
}
