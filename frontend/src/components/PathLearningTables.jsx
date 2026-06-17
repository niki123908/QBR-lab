import { formatPathLearningStat } from "../utils/pathLearningStats.js";

function PathQTable({ rows, title }) {
  if (!rows?.length) return null;
  return (
    <div className="path-learning-table-block">
      <h5 className="path-learning-table-title">{title}</h5>
      <div className="table-scroll path-learning-table-scroll">
        <table className="node-edit-table path-learning-table">
          <thead>
            <tr>
              <th>Timeslot</th>
              <th>Action</th>
              <th>Q value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${title}-${row.timeslot}-${row.action}`}>
                <td>{row.timeslot}</td>
                <td>
                  {formatPathLearningStat(row.action)}
                  {row.actionAggregated ? <span className="muted"> (grp)</span> : null}
                </td>
                <td>{formatPathLearningStat(row.qValue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function PathLearningTables({ bestRows, lastRows }) {
  if (!bestRows?.length && !lastRows?.length) return null;
  return (
    <div className="path-learning-tables">
      <PathQTable rows={bestRows} title="Best path" />
      <PathQTable rows={lastRows} title="Last path" />
    </div>
  );
}
