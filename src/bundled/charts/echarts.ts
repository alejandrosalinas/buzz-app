// Only these chart types and components are registered; the sanitizer rejects
// any other series type before ECharts sees it.
import {
  BarChart,
  BoxplotChart,
  CandlestickChart,
  FunnelChart,
  GaugeChart,
  HeatmapChart,
  LineChart,
  PieChart,
  RadarChart,
  SankeyChart,
  ScatterChart,
  TreemapChart,
} from "echarts/charts";
import {
  AriaComponent,
  AxisPointerComponent,
  DatasetComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  PolarComponent,
  RadarComponent,
  TooltipComponent,
  TransformComponent,
  VisualMapComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { LabelLayout, LegacyGridContainLabel } from "echarts/features";
import { SVGRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  LineChart,
  ScatterChart,
  PieChart,
  HeatmapChart,
  FunnelChart,
  GaugeChart,
  BoxplotChart,
  CandlestickChart,
  SankeyChart,
  TreemapChart,
  RadarChart,
  GridComponent,
  TooltipComponent,
  AxisPointerComponent,
  LegendComponent,
  DatasetComponent,
  TransformComponent,
  VisualMapComponent,
  DataZoomComponent,
  MarkLineComponent,
  MarkAreaComponent,
  MarkPointComponent,
  AriaComponent,
  PolarComponent,
  RadarComponent,
  LabelLayout,
  LegacyGridContainLabel,
  SVGRenderer,
]);

export { echarts };
