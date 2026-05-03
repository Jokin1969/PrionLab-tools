import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

export const ProgressChart = ({ data }) => {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="month" />
        <YAxis />
        <Tooltip />
        <Legend />
        <Line
          type="monotone"
          dataKey="read"
          stroke="#4F46E5"
          strokeWidth={2}
          name="Leídos"
        />
        <Line
          type="monotone"
          dataKey="evaluated"
          stroke="#10B981"
          strokeWidth={2}
          name="Evaluados"
        />
      </LineChart>
    </ResponsiveContainer>
  );
};
