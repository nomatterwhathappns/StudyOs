import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import ErrorBoundary from "./components/ErrorBoundary";
import { PaletteProvider } from "./contexts/PaletteContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { SourceAiActivityProvider } from "./contexts/SourceAiActivityContext";
import { WatchTimerProvider } from "./contexts/WatchTimerContext";
import { AiActivityMenu } from "./components/studyos/AiActivityMenu";
import { OwnerAccessGate } from "./contexts/OwnerAccessContext";
import Home, { HomeView } from "./pages/Home";
import StudyWorkspace from "./pages/StudyWorkspace";
import NotFound from "./pages/NotFound";
import { Route, Switch } from "wouter";

function Router() {
  return (
    <Switch>
      <Route path="/sessions">
        {() => <HomeView initialView="sessions" />}
      </Route>
      <Route path="/" component={Home} />
      <Route path="/studych" component={StudyWorkspace} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <OwnerAccessGate>
        <ThemeProvider defaultTheme="dark">
          <PaletteProvider>
            <WatchTimerProvider>
              <SourceAiActivityProvider>
                <TooltipProvider>
                  <Toaster />
                  <Router />
                  <AiActivityMenu />
                </TooltipProvider>
              </SourceAiActivityProvider>
            </WatchTimerProvider>
          </PaletteProvider>
        </ThemeProvider>
      </OwnerAccessGate>
    </ErrorBoundary>
  );
}
