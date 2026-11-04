export const DEFAULT_ENERGY = {
  distribution: "uniform", harvest_min: 1, harvest_max: 10, harvest_mode: 5,
  capacity: 100, tx_cost: 20, rx_cost: 10, initial_energy: 0
};

export default function EnergyGenerationFields({ value, onChange }) {
  const energy = value ?? DEFAULT_ENERGY;
  const update = (key, next) => onChange({ ...energy, [key]: next });
  const field = (key, label, min = 0.000001, max) => (
    <label className="field-label" key={key}>{label}
      <input type="number" required step="any" min={min} max={max} value={energy[key]}
        onChange={(event) => update(key, event.target.value === "" ? "" : Number(event.target.value))} />
    </label>
  );
  return <fieldset className="energy-generation-fields">
    <legend>Energy defaults</legend>
    <div className="energy-fields-grid">
      <label className="field-label">Harvest distribution
        <select value={energy.distribution} onChange={(event) => update("distribution", event.target.value)}>
          <option value="uniform">Uniform</option><option value="triangular">Triangular</option>
        </select>
      </label>
      {field("harvest_min", "Harvest min (EU/slot)", 0.000001, Number(energy.harvest_max))}
      {field("harvest_max", "Harvest max (EU/slot)", Number(energy.harvest_min) || 0.000001)}
      {energy.distribution === "triangular" && field("harvest_mode", "Harvest peak (EU/slot)", Number(energy.harvest_min), Number(energy.harvest_max))}
      {field("capacity", "Max energy (EU)", Math.max(Number(energy.tx_cost), Number(energy.rx_cost), 0.000001))}
      {field("tx_cost", "TX cost (EU/packet)", 0.000001, Number(energy.capacity))}
      {field("rx_cost", "RX cost (EU/packet)", 0.000001, Number(energy.capacity))}
    </div>
    <p className="muted">Rates are sampled once per node. Sensors start at 0 EU; source node 0 has unlimited energy.</p>
    <p className="muted">Max energy and TX/RX costs are topology defaults for future run configuration.</p>
  </fieldset>;
}
