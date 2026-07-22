import type { CSSProperties } from 'react'
import type { BurnIntensity } from '../burn/burn-intensity'

const SPARK_COUNT = 12

interface Props {
  intensity: BurnIntensity
}

export function BurnHeatFrame({ intensity }: Props) {
  if (intensity === 'off') return null

  return (
    <div
      className={`burn-heat-frame burn-heat-frame--${intensity}`}
      aria-hidden="true"
    >
      <span className="burn-edge burn-edge-top" />
      <span className="burn-edge burn-edge-right" />
      <span className="burn-edge burn-edge-bottom" />
      <span className="burn-edge burn-edge-left" />
      <span className="burn-corner burn-corner-tl" />
      <span className="burn-corner burn-corner-tr" />
      <span className="burn-corner burn-corner-bl" />
      <span className="burn-corner burn-corner-br" />
      {intensity === 'blaze'
        ? Array.from({ length: SPARK_COUNT }, (_, index) => (
          <span
            key={index}
            className="burn-spark"
            style={{ '--spark-i': index } as CSSProperties}
          />
        ))
        : null}
    </div>
  )
}
