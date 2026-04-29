import {
  useGetLedgerSummary,
  useGetValueByAgent,
  useGetValueOverTime,
  useGetRecentActivity,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatDistanceToNow, format } from "date-fns";
import {
  Bar,
  BarChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  AreaChart,
  Area,
  CartesianGrid,
} from "recharts";
import { Activity, CheckCircle2, DollarSign, ListTodo } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export default function Dashboard() {
  const { data: summary, isLoading: loadingSummary } = useGetLedgerSummary();
  const { data: valueByAgent, isLoading: loadingByAgent } = useGetValueByAgent();
  const { data: valueOverTime, isLoading: loadingOverTime } = useGetValueOverTime();
  const { data: recentActivity, isLoading: loadingActivity } = useGetRecentActivity({ limit: 10 });

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Dashboard</h1>
        <p className="text-muted-foreground">Overview of agent outcomes and verified value.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Total Claims"
          value={summary ? String(summary.totalClaims ?? 0) : undefined}
          icon={ListTodo}
          loading={loadingSummary}
        />
        <MetricCard
          title="Verified Outcomes"
          value={summary ? String(summary.verifiedCount ?? 0) : undefined}
          icon={CheckCircle2}
          loading={loadingSummary}
        />
        <MetricCard
          title="Verified Value"
          value={
            summary
              ? `$${Number(summary.verifiedValueUsd ?? 0).toLocaleString()}`
              : undefined
          }
          icon={DollarSign}
          loading={loadingSummary}
        />
        <MetricCard
          title="Billable Revenue"
          value={
            summary
              ? `$${Number(summary.billableUsd ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : undefined
          }
          icon={DollarSign}
          loading={loadingSummary}
          highlight
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <Card className="col-span-4">
          <CardHeader>
            <CardTitle>Verified Value Over Time</CardTitle>
            <CardDescription>Daily verified value for the last 30 days</CardDescription>
          </CardHeader>
          <CardContent className="h-[300px]">
            {loadingOverTime ? (
              <Skeleton className="w-full h-full" />
            ) : valueOverTime && valueOverTime.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={valueOverTime}>
                  <defs>
                    <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis 
                    dataKey="date" 
                    tickFormatter={(val) => format(new Date(val), 'MMM d')}
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis 
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => `$${value}`}
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }}
                    labelFormatter={(val) => format(new Date(val), 'MMM d, yyyy')}
                    formatter={(value: number) => [`$${value.toLocaleString()}`, 'Verified Value']}
                  />
                  <Area
                    type="monotone"
                    dataKey="verifiedValueUsd"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorValue)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                No data available
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-3">
          <CardHeader>
            <CardTitle>Value by Agent</CardTitle>
            <CardDescription>Total verified value per agent</CardDescription>
          </CardHeader>
          <CardContent className="h-[300px]">
            {loadingByAgent ? (
              <Skeleton className="w-full h-full" />
            ) : valueByAgent && valueByAgent.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={valueByAgent} layout="vertical" margin={{ left: 0, right: 0, top: 0, bottom: 0 }}>
                  <XAxis type="number" hide />
                  <YAxis 
                    dataKey="agentName" 
                    type="category" 
                    axisLine={false} 
                    tickLine={false} 
                    fontSize={12}
                    width={100}
                  />
                  <Tooltip 
                    cursor={{ fill: 'hsl(var(--muted))' }}
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }}
                    formatter={(value: number) => [`$${value.toLocaleString()}`, 'Verified Value']}
                  />
                  <Bar dataKey="verifiedValueUsd" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                No data available
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
          <CardDescription>Latest claim events across all agents</CardDescription>
        </CardHeader>
        <CardContent>
          {loadingActivity ? (
            <div className="space-y-4">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : recentActivity && recentActivity.length > 0 ? (
            <div className="space-y-4">
              {recentActivity.map((activity) => (
                <div key={activity.eventId} className="flex items-center gap-4">
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                    <Activity className="w-4 h-4" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium">
                      Claim <span className="font-semibold">{activity.claimTitle}</span> was {activity.eventType} by {activity.actor}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Agent: {activity.agentName} • Value: ${activity.valueUsd.toLocaleString()}
                    </p>
                  </div>
                  <div className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatDistanceToNow(new Date(activity.createdAt), { addSuffix: true })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-4 text-muted-foreground">
              No recent activity
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MetricCard({ title, value, icon: Icon, loading, highlight }: any) {
  return (
    <Card className={highlight ? "border-primary shadow-sm" : ""}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-20" />
        ) : (
          <div className={`text-2xl font-bold ${highlight ? 'text-primary' : ''}`}>
            {value !== undefined ? value : "0"}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
