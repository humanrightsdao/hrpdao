import { useTranslation } from "react-i18next";
import { fmtNum } from "../lib/format";

// A thin "ledger" strip with divisions instead of a rounded progress bar —
// FOR / AGAINST / ABSTAIN votes read like an entry in an accounting ledger.
export default function VoteBar({ forVotes, againstVotes, abstainVotes, compact = false }) {
  const { t } = useTranslation();
  const f = Number(forVotes) || 0;
  const a = Number(againstVotes) || 0;
  const ab = Number(abstainVotes) || 0;
  const total = f + a + ab;
  const pct = (n) => (total > 0 ? (n / total) * 100 : 0);

  return (
    <div className="w-full">
      <div className="flex h-2 w-full overflow-hidden rounded-[1px] border border-hairline">
        <div style={{ width: `${pct(f)}%` }} className="bg-verdigris" />
        <div style={{ width: `${pct(a)}%` }} className="bg-seal" />
        <div style={{ width: `${pct(ab)}%` }} className="bg-parchmentDim/50" />
      </div>
      {!compact && (
        <div className="flex justify-between mt-1.5 font-mono text-[12px] text-parchmentDim num-tabular">
          <span className="text-verdigrisBright">{t("dao.common.for")} · {fmtNum(f)}</span>
          <span className="text-seal">{t("dao.common.against")} · {fmtNum(a)}</span>
          <span>{t("dao.common.abstain")} · {fmtNum(ab)}</span>
        </div>
      )}
    </div>
  );
}
