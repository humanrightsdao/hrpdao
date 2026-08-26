import { useEffect } from "react";
import { useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Trophy, Globe2, Layers, Users } from "lucide-react";
import { fmtRelative } from "../lib/format";

export default function RankingPage() {
  const { t } = useTranslation();
  const dao = useOutletContext();

  useEffect(() => {
    dao.loadRankingOverview?.();
    if (dao.isConnected) dao.refreshTokenStatus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dao.account]);

  const o = dao.rankingOverview;
  const eff = dao.myEffectiveHex;

  return (
    <div className="fade-rise max-w-2xl">
      <div className="font-mono text-xs tracking-[0.2em] text-verdigrisBright uppercase mb-2">
        {t("dao.ranking.community")}
      </div>
      <h1 className="font-display font-semibold text-3xl text-parchment mb-8 flex items-center gap-3">
        <Trophy size={26} className="text-gold" />
        {t("dao.ranking.title")}
      </h1>

      <div className="rounded-2xl border border-hairline p-6 sm:p-8 mb-6">
        <p className="text-parchmentDim text-sm leading-relaxed">
          {t("dao.ranking.description")}
        </p>
      </div>

      {!o ? (
        <div className="rounded-2xl border border-hairline p-8 text-center">
          <p className="text-parchmentDim text-sm">{t("dao.ranking.loadingEpoch")}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 mb-6">
            <StatCard
              icon={<Layers size={16} />}
              label={t("dao.ranking.currentEpoch")}
              value={`#${o.epoch}`}
              sub={
                o.epochStartedAt
                  ? t("dao.ranking.epochStarted", { time: fmtRelative(o.epochStartedAt) })
                  : t("dao.ranking.epochNotStarted")
              }
            />
            <StatCard
              icon={<Globe2 size={16} />}
              label={t("dao.ranking.activeHexagons")}
              value={o.totalActiveHexagons}
              sub={t("dao.ranking.excludingEarth")}
            />
            <StatCard
              icon={<Users size={16} />}
              label={t("dao.ranking.nodeCapacity")}
              value={o.nodeCapacity}
              sub={t("dao.ranking.seatsPerNode")}
            />
            <StatCard
              icon={<Trophy size={16} />}
              label={t("dao.ranking.turnoutQuorum")}
              value={`${o.quorumPct}%`}
              sub={t("dao.ranking.epochMinDays", { days: o.minEpochDurationDays.toFixed(0) })}
            />
          </div>

          <div className="rounded-2xl border border-hairline p-6 sm:p-8 mb-6">
            <div className="font-mono text-[12px] uppercase tracking-widest text-parchmentDim mb-2">
              {t("dao.ranking.earthStatus")}
            </div>
            <div
              className={
                "font-mono text-sm " +
                (o.earthOverflowed ? "text-verdigrisBright" : "text-parchmentDim")
              }
            >
              {o.earthOverflowed
                ? t("dao.ranking.earthOverflowed")
                : t("dao.ranking.earthNotOverflowed")}
            </div>
          </div>
        </>
      )}

      {dao.isConnected && (
        <div className="rounded-2xl border border-hairline p-6 sm:p-8">
          <div className="font-mono text-[12px] uppercase tracking-widest text-parchmentDim mb-2">
            {t("dao.ranking.yourLevel")}
          </div>
          <div className="font-display text-2xl text-parchment">
            {eff && eff.level >= 0 ? t("dao.ranking.levelN", { n: eff.level }) : t("dao.ranking.earthGlobal")}
          </div>
          <p className="font-mono text-[12px] text-parchmentDim/70 mt-2">
            {t("dao.ranking.levelExplanation")}
          </p>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, sub }) {
  return (
    <div className="rounded-2xl border border-hairline p-5">
      <div className="flex items-center gap-2 font-mono text-[12px] uppercase tracking-widest text-parchmentDim mb-2">
        {icon}
        {label}
      </div>
      <div className="font-display text-2xl text-parchment num-tabular">{value}</div>
      {sub && <div className="font-mono text-[12px] text-parchmentDim/70 mt-1">{sub}</div>}
    </div>
  );
}
