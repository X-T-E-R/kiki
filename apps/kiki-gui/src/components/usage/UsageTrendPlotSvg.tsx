import type { UsageMetric } from '../../lib/usageV2';
import type { TrendGeometry } from './usageTrendMath';

export type UsageTrendVisualMode = 'ribbon' | 'bars';

export function UsageTrendPlotSvg({
  svgAriaLabel,
  plotWidth,
  plotHeight,
  geometry,
  visualMode,
  metric,
  activeHighlight,
  highlightColor,
  primaryStroke,
  cacheRefY,
  overallCacheHit,
  scrubIndex,
  selectedKey,
  barColWidth,
}: {
  readonly svgAriaLabel: string;
  readonly plotWidth: number;
  readonly plotHeight: number;
  readonly geometry: TrendGeometry;
  readonly visualMode: UsageTrendVisualMode;
  readonly metric: UsageMetric;
  readonly activeHighlight: string | null;
  readonly highlightColor: string;
  readonly primaryStroke: string;
  readonly cacheRefY: number | null;
  readonly overallCacheHit: number | null | undefined;
  readonly scrubIndex: number | null;
  readonly selectedKey: string | null;
  readonly barColWidth: number;
}) {
  const plotH = geometry.yBase - geometry.padTop;

  return (
    <svg
      role="img"
      aria-label={svgAriaLabel}
      data-usage-trend-svg
      viewBox={`0 0 ${plotWidth} ${plotHeight}`}
      className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
    >
      {/* Horizontal calibration hairlines */}
      {[0, 0.5, 1].map((frac) => {
        const y = geometry.padTop + frac * plotH;
        return (
          <line
            key={frac}
            x1={0}
            y1={y}
            x2={plotWidth}
            y2={y}
            stroke="var(--color-hairline)"
            strokeWidth="1"
          />
        );
      })}

      {/* Cache-hit overall reference line */}
      {cacheRefY !== null && overallCacheHit !== null && overallCacheHit !== undefined ? (
        <line
          data-usage-cache-ref-line
          x1={0}
          y1={cacheRefY}
          x2={plotWidth}
          y2={cacheRefY}
          stroke="var(--kiki-chart-3)"
          strokeWidth="1.25"
          strokeDasharray="4 3"
        />
      ) : null}

      {visualMode === 'ribbon' ? (
        <>
          {/* Continuous Non-Crossing Hermite Ribbons */}
          {geometry.runs.map((run) => {
            if (activeHighlight !== null && metric !== 'cache') {
              return (
                <g key={`run:${run.startIndex}`} data-usage-ribbon-run>
                  <path
                    d={run.upperBandPath}
                    fill="color-mix(in srgb, var(--kiki-chart-1) 8%, transparent)"
                  />
                  <path
                    d={run.lowerAreaPath}
                    fill={`color-mix(in srgb, ${highlightColor} 28%, transparent)`}
                  />
                  <path
                    d={run.topStrokePath}
                    fill="none"
                    stroke="color-mix(in srgb, var(--kiki-chart-1) 42%, transparent)"
                    strokeWidth="1.25"
                  />
                  <path
                    d={run.dividerStrokePath}
                    fill="none"
                    stroke={highlightColor}
                    strokeWidth="2"
                  />
                </g>
              );
            }

            if (metric === 'tokens') {
              return (
                <g key={`run:${run.startIndex}`} data-usage-ribbon-run>
                  <path
                    d={run.lowerAreaPath}
                    fill="color-mix(in srgb, var(--kiki-chart-5) 14%, transparent)"
                  />
                  <path
                    d={run.upperBandPath}
                    fill="color-mix(in srgb, var(--kiki-chart-1) 24%, transparent)"
                  />
                  <path
                    data-usage-ribbon-divider
                    d={run.dividerStrokePath}
                    fill="none"
                    stroke="var(--kiki-chart-5)"
                    strokeWidth="1.6"
                  />
                  <path
                    d={run.topStrokePath}
                    fill="none"
                    stroke={primaryStroke}
                    strokeWidth="2"
                  />
                </g>
              );
            }

            const areaD = [
              run.topStrokePath,
              `L ${run.points.at(-1)!.x.toFixed(2)} ${geometry.yBase.toFixed(2)}`,
              `L ${run.points[0]!.x.toFixed(2)} ${geometry.yBase.toFixed(2)}`,
              'Z',
            ].join(' ');
            return (
              <g key={`run:${run.startIndex}`} data-usage-ribbon-run>
                <path
                  d={areaD}
                  fill={`color-mix(in srgb, ${primaryStroke} 15%, transparent)`}
                />
                <path
                  d={run.topStrokePath}
                  fill="none"
                  stroke={primaryStroke}
                  strokeWidth="2"
                />
              </g>
            );
          })}

          {/* Isolated Nonzero Buckets ([0, 476k, 0] or sparse gap): crisp stacked vertical stems + dot */}
          {geometry.isolatedPoints.map((pt) => {
            const hasStack = (metric === 'tokens' || activeHighlight !== null) && pt.lower > 0;
            const lowerStroke = activeHighlight !== null
              ? highlightColor
              : 'var(--kiki-chart-5)';
            const upperStroke = activeHighlight !== null
              ? 'color-mix(in srgb, var(--kiki-chart-1) 26%, transparent)'
              : primaryStroke;
            return (
              <g key={`stem:${pt.key}`} data-usage-isolated-stem={pt.key}>
                {pt.yTotal < geometry.yBase ? (
                  hasStack ? (
                    <>
                      <line
                        x1={pt.x}
                        y1={geometry.yBase}
                        x2={pt.x}
                        y2={pt.yLower}
                        stroke={lowerStroke}
                        strokeWidth="4"
                      />
                      {pt.yTotal < pt.yLower ? (
                        <line
                          x1={pt.x}
                          y1={pt.yLower}
                          x2={pt.x}
                          y2={pt.yTotal}
                          stroke={upperStroke}
                          strokeWidth="4"
                        />
                      ) : null}
                    </>
                  ) : (
                    <line
                      x1={pt.x}
                      y1={geometry.yBase}
                      x2={pt.x}
                      y2={pt.yTotal}
                      stroke={primaryStroke}
                      strokeWidth="3.5"
                    />
                  )
                ) : null}
              </g>
            );
          })}

          {/* Observed Midpoint Dots on completed points */}
          {geometry.points.map((pt) => {
            if (!pt.joinsRibbon) return null;
            const isFocused = scrubIndex === pt.index || selectedKey === pt.key;
            const dotY = activeHighlight !== null && metric !== 'cache' ? pt.yLower : pt.yTotal;
            const dotFill = activeHighlight !== null && metric !== 'cache' ? highlightColor : primaryStroke;
            return (
              <circle
                key={`dot:${pt.key}`}
                cx={pt.x}
                cy={dotY}
                r={isFocused ? 4.25 : 2.75}
                fill={dotFill}
                stroke="var(--color-paper)"
                strokeWidth="1.25"
              />
            );
          })}

          {/* In-progress current bucket: dashed stem + open paper-filled ring dot */}
          {geometry.inProgressPoints.map((pt) => (
            <g key={`prog:${pt.key}`} data-usage-in-progress-marker={pt.key}>
              {pt.yTotal < geometry.yBase ? (
                <line
                  x1={pt.x}
                  y1={geometry.yBase}
                  x2={pt.x}
                  y2={pt.yTotal}
                  stroke={primaryStroke}
                  strokeOpacity="0.6"
                  strokeWidth="1.5"
                  strokeDasharray="3 2.5"
                />
              ) : null}
              <circle
                cx={pt.x}
                cy={pt.yTotal}
                r={scrubIndex === pt.index ? 4.5 : 3.75}
                fill="var(--color-paper)"
                stroke={primaryStroke}
                strokeWidth="2"
              />
            </g>
          ))}

          {/* Subtle baseline ticks strictly on measured zero buckets (never on missing cache input or unknown cost) */}
          {geometry.points.map((pt) => {
            if (pt.pointState === 'unknown') {
              return (
                <line
                  key={`unk:${pt.key}`}
                  data-usage-unknown-marker={pt.key}
                  x1={pt.x - 3}
                  y1={geometry.yBase}
                  x2={pt.x + 3}
                  y2={geometry.yBase}
                  stroke="var(--color-amber-rule)"
                  strokeWidth="1.75"
                  strokeDasharray="1.5 1.5"
                />
              );
            }
            if (pt.pointState !== 'measured_zero' || pt.joinsRibbon) return null;
            return (
              <line
                key={`zero:${pt.key}`}
                x1={pt.x - 2.5}
                y1={geometry.yBase}
                x2={pt.x + 2.5}
                y2={geometry.yBase}
                stroke="var(--color-hairline-strong)"
                strokeWidth="1.5"
              />
            );
          })}
        </>
      ) : (
        /* Discrete Columns Mode (`柱状`) */
        geometry.points.map((pt) => {
          if (pt.pointState === 'unknown') {
            return (
              <line
                key={`col-unk:${pt.key}`}
                data-usage-unknown-marker={pt.key}
                x1={pt.x - barColWidth / 2}
                y1={geometry.yBase}
                x2={pt.x + barColWidth / 2}
                y2={geometry.yBase}
                stroke="var(--color-amber-rule)"
                strokeWidth="1.75"
                strokeDasharray="2 2"
              />
            );
          }
          if (pt.total === null || pt.total <= 0) {
            if (pt.pointState === 'measured_zero') {
              return (
                <line
                  key={`col-zero:${pt.key}`}
                  x1={pt.x - barColWidth / 2}
                  y1={geometry.yBase}
                  x2={pt.x + barColWidth / 2}
                  y2={geometry.yBase}
                  stroke="var(--color-hairline-strong)"
                  strokeWidth="1.5"
                />
              );
            }
            return null;
          }
          const colX = pt.x - barColWidth / 2;
          const totalH = Math.max(2, geometry.yBase - pt.yTotal);
          const lowerH = Math.max(0, geometry.yBase - pt.yLower);
          const upperH = Math.max(0, totalH - lowerH);
          const dimmed = selectedKey !== null && selectedKey !== pt.key;
          return (
            <g key={`col:${pt.key}`} opacity={dimmed ? 0.45 : pt.isInProgress ? 0.68 : 1}>
              {activeHighlight !== null && metric !== 'cache' ? (
                <>
                  {upperH > 0 ? (
                    <rect
                      x={colX}
                      y={geometry.yBase - totalH}
                      width={barColWidth}
                      height={upperH}
                      fill="color-mix(in srgb, var(--kiki-chart-1) 14%, transparent)"
                    />
                  ) : null}
                  {lowerH > 0 ? (
                    <rect
                      x={colX}
                      y={geometry.yBase - lowerH}
                      width={barColWidth}
                      height={lowerH}
                      fill={highlightColor}
                    />
                  ) : null}
                </>
              ) : metric === 'tokens' ? (
                <>
                  {lowerH > 0 ? (
                    <rect
                      x={colX}
                      y={geometry.yBase - lowerH}
                      width={barColWidth}
                      height={lowerH}
                      fill="color-mix(in srgb, var(--kiki-chart-5) 38%, transparent)"
                    />
                  ) : null}
                  {upperH > 0 ? (
                    <rect
                      x={colX}
                      y={geometry.yBase - totalH}
                      width={barColWidth}
                      height={Math.max(1, upperH - (lowerH > 0 ? 1 : 0))}
                      fill={primaryStroke}
                    />
                  ) : null}
                </>
              ) : (
                <rect
                  x={colX}
                  y={geometry.yBase - totalH}
                  width={barColWidth}
                  height={totalH}
                  fill={primaryStroke}
                  fillOpacity="0.82"
                />
              )}
            </g>
          );
        })
      )}

      {/* Vertical Scrubhair strictly tied to observed bucket midpoint */}
      {scrubIndex !== null && geometry.points[scrubIndex] !== undefined ? (
        <line
          data-usage-trend-scrubhair
          x1={geometry.points[scrubIndex]!.x}
          y1={geometry.padTop - 4}
          x2={geometry.points[scrubIndex]!.x}
          y2={geometry.yBase}
          stroke="var(--color-ink)"
          strokeOpacity="0.34"
          strokeWidth="1"
          strokeDasharray="2.5 2.5"
        />
      ) : null}
    </svg>
  );
}
