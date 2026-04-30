import { Switch, Route, Router as WouterRouter } from "wouter";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import { Layout } from "./components/layout";
import Landing from "./pages/landing";
import Dashboard from "./pages/dashboard";
import SpendOverview from "./pages/spend";
import Opportunities from "./pages/opportunities";
import OpportunityDetail from "./pages/opportunity-detail";
import Approvals from "./pages/approvals";
import Ooda from "./pages/ooda";
import Results from "./pages/results";
import Playbook from "./pages/playbook";
import Collectors from "./pages/collectors";
import System from "./pages/system";
import Ingest from "./pages/ingest";

function Router() {
  return (
    <Switch>
      <Route path="/landing" component={Landing} />
      <Route>
        <Layout>
          <Switch>
            <Route path="/" component={Dashboard} />
            <Route path="/spend" component={SpendOverview} />
            <Route path="/opportunities" component={Opportunities} />
            <Route path="/opportunities/:id" component={OpportunityDetail} />
            <Route path="/approvals" component={Approvals} />
            <Route path="/ooda" component={Ooda} />
            <Route path="/results" component={Results} />
            <Route path="/playbook" component={Playbook} />
            <Route path="/collectors" component={Collectors} />
            <Route path="/system" component={System} />
            <Route path="/ingest" component={Ingest} />
            <Route component={NotFound} />
          </Switch>
        </Layout>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <TooltipProvider>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <Router />
      </WouterRouter>
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
