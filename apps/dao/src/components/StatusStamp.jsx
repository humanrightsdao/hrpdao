import { useTranslation } from "react-i18next";
import { STATE_META } from "../lib/format";

export default function StatusStamp({ state }) {
  const { t } = useTranslation();
  const meta = STATE_META[state] || { color: "#948C7A" };
  const label = state ? t(`dao.proposalStates.${state}`, { defaultValue: state }) : "—";
  return (
    <span className="status-stamp" style={{ "--stamp-color": meta.color }}>
      {label}
    </span>
  );
}
