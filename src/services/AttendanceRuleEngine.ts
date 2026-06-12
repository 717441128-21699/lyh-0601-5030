import {
  HolidayConfig,
  WeekendConfig,
  Shift,
  LeaveType,
  LeaveBalance,
  LeaveRequest,
  WorkSchedule,
  PunchRecord,
  OvertimeRecord,
  LeaveCalculationRequest,
  LeaveCalculationResult,
  AttendanceResult,
  MonthlyAttendanceSummary,
  ConflictCheckRequest,
  ConflictCheckResult,
  LeaveTypeCode,
  LeaveUnit,
} from '../types';

import { WorkdayChecker } from './WorkdayChecker';
import { ShiftCalculator } from './ShiftCalculator';
import { LeaveBalanceManager, DeductionResult, RollbackResult } from './LeaveBalanceManager';
import { LeaveSplitter } from './LeaveSplitter';
import { CompensatoryLeaveManager } from './CompensatoryLeaveManager';
import { AttendanceChecker } from './AttendanceChecker';
import { ConflictChecker } from './ConflictChecker';
import { MonthlySummaryGenerator } from './MonthlySummaryGenerator';
import { MonthlySummaryParams } from './MonthlySummaryGenerator';
import { roundHours } from '../utils/dateUtils';
import {
  CompensatoryConversionResult,
  CompensatoryUseResult,
  CompensatoryRollbackResult,
} from './CompensatoryLeaveManager';

export interface EngineConfig {
  holidays?: HolidayConfig[];
  weekendConfig?: WeekendConfig;
  shifts?: Shift[];
  leaveTypes?: LeaveType[];
  leaveBalances?: LeaveBalance[];
  overtimeRecords?: OvertimeRecord[];
}

export interface ApplyLeaveParams {
  employeeId: string;
  leaveTypeCode: LeaveTypeCode;
  startTime: string;
  endTime: string;
  unit: LeaveUnit;
  schedules: WorkSchedule[];
  existingLeaves?: LeaveRequest[];
  excludeRequestId?: string;
  autoDeduct?: boolean;
}

export interface ApplyLeaveResult {
  success: boolean;
  calculation: LeaveCalculationResult;
  deduction?: DeductionResult;
  tips: string[];
  warnings: string[];
}

export interface CancelLeaveParams {
  leaveRequest: LeaveRequest;
  autoRollback?: boolean;
}

export interface CancelLeaveResult {
  success: boolean;
  rollback?: RollbackResult;
  message: string;
}

export interface BatchApplyLeaveParams {
  requests: ApplyLeaveParams[];
}

export interface ApplyLeaveResultWithId extends ApplyLeaveResult {
  requestId?: string;
  employeeId: string;
  leaveTypeCode: LeaveTypeCode;
}

export interface BatchApplyLeaveSummary {
  totalCount: number;
  successCount: number;
  failedCount: number;
  totalDeductedHours: number;
  conflictCount: number;
  insufficientBalanceCount: number;
}

export interface BatchApplyLeaveResult {
  success: boolean;
  results: Map<string, ApplyLeaveResultWithId[]>;
  resultsByEmployee: Record<string, ApplyLeaveResultWithId[]>;
  summary: BatchApplyLeaveSummary;
}

export interface BatchMonthlySummaryParams {
  items: Array<{
    employee: { id: string; name?: string; department?: string };
    params: MonthlySummaryParams;
  }>;
}

export interface DepartmentMonthlySummary {
  departmentName: string;
  employeeCount: number;
  totalWorkDays: number;
  totalActualWorkDays: number;
  totalWorkHours: number;
  totalActualWorkHours: number;
  totalLateCount: number;
  totalLateMinutes: number;
  totalEarlyLeaveCount: number;
  totalEarlyLeaveMinutes: number;
  totalAbsentDays: number;
  totalLeaveHours: number;
  totalOvertimeHours: number;
  totalCompensatoryUsedHours: number;
  totalCompensatoryRemainingHours: number;
  totalBusinessTripDays: number;
  totalAnomalyCount: number;
}

export interface BatchMonthlySummaryResult {
  summaries: Record<string, MonthlyAttendanceSummary>;
  byDepartment: Record<string, DepartmentMonthlySummary>;
  overallSummary: DepartmentMonthlySummary;
}

export class AttendanceRuleEngine {
  private workdayChecker: WorkdayChecker;
  private shiftCalculator: ShiftCalculator;
  private leaveBalanceManager: LeaveBalanceManager;
  private leaveSplitter: LeaveSplitter;
  private compensatoryLeaveManager: CompensatoryLeaveManager;
  private attendanceChecker: AttendanceChecker;
  private conflictChecker: ConflictChecker;
  private monthlySummaryGenerator: MonthlySummaryGenerator;
  private shifts: Map<string, Shift>;
  private leaveTypes: Map<string, LeaveType>;

  constructor(config: EngineConfig = {}) {
    this.workdayChecker = new WorkdayChecker(
      config.holidays,
      config.weekendConfig
    );
    this.shiftCalculator = new ShiftCalculator();
    this.leaveBalanceManager = new LeaveBalanceManager(config.leaveBalances);
    this.leaveSplitter = new LeaveSplitter(
      this.workdayChecker,
      this.shiftCalculator,
      config.leaveTypes
    );
    this.compensatoryLeaveManager = new CompensatoryLeaveManager(
      this.leaveBalanceManager,
      config.overtimeRecords
    );
    this.attendanceChecker = new AttendanceChecker(
      this.workdayChecker,
      this.shiftCalculator
    );
    this.conflictChecker = new ConflictChecker(this.workdayChecker);
    this.monthlySummaryGenerator = new MonthlySummaryGenerator(
      this.workdayChecker,
      this.shiftCalculator,
      this.attendanceChecker
    );

    this.shifts = new Map();
    this.leaveTypes = new Map();

    (config.shifts || []).forEach((s) => this.shifts.set(s.id, s));
    (config.leaveTypes || []).forEach((lt) => this.leaveTypes.set(lt.code, lt));
  }

  isWorkDay(date: string, shiftWorkDays?: number[]): boolean {
    return this.workdayChecker.isWorkDay(date, shiftWorkDays);
  }

  isHoliday(date: string): boolean {
    return this.workdayChecker.isHoliday(date);
  }

  isWeekend(date: string): boolean {
    return this.workdayChecker.isWeekend(date);
  }

  getHolidayInfo(date: string): HolidayConfig | undefined {
    return this.workdayChecker.getHolidayInfo(date);
  }

  addHoliday(config: HolidayConfig): void {
    this.workdayChecker.addHoliday(config);
  }

  addHolidays(configs: HolidayConfig[]): void {
    this.workdayChecker.addHolidays(configs);
  }

  setWeekendConfig(config: WeekendConfig): void {
    this.workdayChecker.setWeekendConfig(config);
  }

  calculateShiftHours(shift: Shift) {
    return this.shiftCalculator.calculateShiftHours(shift);
  }

  getShift(shiftId: string): Shift | undefined {
    return this.shifts.get(shiftId);
  }

  addShift(shift: Shift): void {
    this.shifts.set(shift.id, shift);
  }

  getLeaveType(code: string): LeaveType | undefined {
    return this.leaveTypes.get(code);
  }

  addLeaveType(leaveType: LeaveType): void {
    this.leaveTypes.set(leaveType.code, leaveType);
    this.leaveSplitter.addLeaveType(leaveType);
  }

  setLeaveTypes(leaveTypes: LeaveType[]): void {
    this.leaveTypes.clear();
    leaveTypes.forEach((lt) => {
      this.leaveTypes.set(lt.code, lt);
    });
    this.leaveSplitter.setLeaveTypes(leaveTypes);
  }

  getLeaveBalance(employeeId: string, leaveTypeCode: LeaveTypeCode): number {
    return this.leaveBalanceManager.getRemainingBalance(employeeId, leaveTypeCode);
  }

  getLeaveBalanceDetail(employeeId: string, leaveTypeCode: LeaveTypeCode) {
    return this.leaveBalanceManager.getBalance(employeeId, leaveTypeCode);
  }

  setLeaveBalance(balance: LeaveBalance): void {
    this.leaveBalanceManager.setBalance(balance);
  }

  setLeaveBalances(balances: LeaveBalance[]): void {
    this.leaveBalanceManager.setBalances(balances);
  }

  calculateLeave(request: LeaveCalculationRequest): LeaveCalculationResult {
    const calcResult = this.leaveSplitter.calculateLeave(request);

    if (calcResult.success && calcResult.deductedHours > 0) {
      const remaining = this.leaveBalanceManager.getRemainingBalance(
        request.employeeId,
        request.leaveTypeCode
      );
      calcResult.remainingBalance = remaining;
      calcResult.insufficientBalance = remaining < calcResult.deductedHours;

      if (calcResult.insufficientBalance) {
        calcResult.warnings.push(
          `额度不足：剩余 ${remaining} 小时，需要 ${calcResult.deductedHours} 小时`
        );
      }
    }

    return calcResult;
  }

  applyLeave(params: ApplyLeaveParams): ApplyLeaveResult {
    const request: LeaveCalculationRequest = {
      employeeId: params.employeeId,
      leaveTypeCode: params.leaveTypeCode,
      startTime: params.startTime,
      endTime: params.endTime,
      unit: params.unit,
      schedules: params.schedules,
      existingLeaves: params.existingLeaves,
      excludeRequestId: params.excludeRequestId,
    };

    const calculation = this.calculateLeave(request);
    const tips: string[] = [...calculation.tips];
    const warnings: string[] = [...calculation.warnings];

    let deduction: DeductionResult | undefined;

    if (params.autoDeduct && calculation.success && !calculation.insufficientBalance && !calculation.hasConflict) {
      deduction = this.leaveBalanceManager.deduct(
        params.employeeId,
        params.leaveTypeCode,
        calculation.deductedHours
      );
      if (!deduction.success) {
        warnings.push(deduction.message);
      } else {
        tips.push(deduction.message);
      }
    }

    const success = calculation.success && !calculation.insufficientBalance && !calculation.hasConflict &&
      (!params.autoDeduct || (deduction?.success ?? false));

    if (calculation.hasConflict && calculation.conflictDetails) {
      warnings.push(...calculation.conflictDetails);
    }

    return {
      success,
      calculation,
      deduction,
      tips,
      warnings,
    };
  }

  cancelLeave(params: CancelLeaveParams): CancelLeaveResult {
    const { leaveRequest, autoRollback = true } = params;

    if (leaveRequest.status !== 'cancelled' && leaveRequest.status !== 'rejected') {
      return {
        success: false,
        message: '只有已撤销或已拒绝的请假单可以回滚额度',
      };
    }

    if (!autoRollback) {
      return {
        success: true,
        message: '请假单已标记为撤销，未自动回滚额度',
      };
    }

    const rollback = this.leaveBalanceManager.rollbackByRequest(leaveRequest);

    return {
      success: rollback.success,
      rollback,
      message: rollback.message,
    };
  }

  checkConflicts(request: ConflictCheckRequest): ConflictCheckResult {
    return this.conflictChecker.checkConflicts(request);
  }

  convertOvertimeToCompensatory(
    overtimeRecordId: string,
    hours?: number,
    minUnitHours?: number
  ): CompensatoryConversionResult {
    return this.compensatoryLeaveManager.convertOvertimeToCompensatory(
      overtimeRecordId,
      hours,
      minUnitHours
    );
  }

  getCompensatoryBalance(employeeId: string): number {
    return this.compensatoryLeaveManager.getBalance(employeeId);
  }

  useCompensatory(employeeId: string, hours: number): CompensatoryUseResult {
    return this.compensatoryLeaveManager.useCompensatory(employeeId, hours);
  }

  rollbackCompensatory(employeeId: string, hours: number): CompensatoryRollbackResult {
    return this.compensatoryLeaveManager.rollbackCompensatory(employeeId, hours);
  }

  addOvertimeRecord(record: OvertimeRecord): void {
    this.compensatoryLeaveManager.addOvertimeRecord(record);
  }

  checkAttendance(
    schedule: WorkSchedule,
    punch?: PunchRecord,
    leaves: LeaveRequest[] = [],
    overtimes: OvertimeRecord[] = []
  ): AttendanceResult {
    return this.attendanceChecker.checkAttendance({
      schedule,
      punch,
      leaves,
      overtimes,
    });
  }

  generateMonthlySummary(params: MonthlySummaryParams): MonthlyAttendanceSummary {
    return this.monthlySummaryGenerator.generate(params);
  }

  getWorkdayChecker(): WorkdayChecker {
    return this.workdayChecker;
  }

  getShiftCalculator(): ShiftCalculator {
    return this.shiftCalculator;
  }

  getLeaveBalanceManager(): LeaveBalanceManager {
    return this.leaveBalanceManager;
  }

  getCompensatoryLeaveManager(): CompensatoryLeaveManager {
    return this.compensatoryLeaveManager;
  }

  applyLeaveBatch(params: BatchApplyLeaveParams): BatchApplyLeaveResult {
    const { requests } = params;
    const resultsMap = new Map<string, ApplyLeaveResultWithId[]>();
    const resultsByEmployee: Record<string, ApplyLeaveResultWithId[]> = {};

    let successCount = 0;
    let failedCount = 0;
    let totalDeductedHours = 0;
    let conflictCount = 0;
    let insufficientBalanceCount = 0;

    for (const req of requests) {
      let result: ApplyLeaveResultWithId;
      try {
        const single = this.applyLeave(req);
        result = {
          ...single,
          requestId: req.excludeRequestId,
          employeeId: req.employeeId,
          leaveTypeCode: req.leaveTypeCode,
        };
      } catch (err) {
        result = {
          success: false,
          requestId: req.excludeRequestId,
          employeeId: req.employeeId,
          leaveTypeCode: req.leaveTypeCode,
          calculation: {
            success: false,
            deductedHours: 0,
            splitSegments: [],
            hasConflict: false,
            insufficientBalance: false,
            warnings: [],
            tips: [],
          },
          tips: [],
          warnings: [`处理异常：${err instanceof Error ? err.message : String(err)}`],
        };
      }

      if (result.success) {
        successCount++;
        if (result.deduction?.success) {
          totalDeductedHours += result.deduction.deductedHours;
        }
      } else {
        failedCount++;
      }
      if (result.calculation.hasConflict) conflictCount++;
      if (result.calculation.insufficientBalance) insufficientBalanceCount++;

      if (!resultsMap.has(req.employeeId)) {
        resultsMap.set(req.employeeId, []);
      }
      resultsMap.get(req.employeeId)!.push(result);

      if (!resultsByEmployee[req.employeeId]) {
        resultsByEmployee[req.employeeId] = [];
      }
      resultsByEmployee[req.employeeId].push(result);
    }

    const summary: BatchApplyLeaveSummary = {
      totalCount: requests.length,
      successCount,
      failedCount,
      totalDeductedHours: roundHours(totalDeductedHours),
      conflictCount,
      insufficientBalanceCount,
    };

    return {
      success: failedCount === 0,
      results: resultsMap,
      resultsByEmployee,
      summary,
    };
  }

  generateMonthlySummaryBatch(params: BatchMonthlySummaryParams): BatchMonthlySummaryResult {
    const summaries: Record<string, MonthlyAttendanceSummary> = {};
    const byDepartment: Record<string, DepartmentMonthlySummary & { _count: number }> = {};

    const createEmptyDept = (name: string): DepartmentMonthlySummary & { _count: number } => ({
      departmentName: name,
      employeeCount: 0,
      totalWorkDays: 0,
      totalActualWorkDays: 0,
      totalWorkHours: 0,
      totalActualWorkHours: 0,
      totalLateCount: 0,
      totalLateMinutes: 0,
      totalEarlyLeaveCount: 0,
      totalEarlyLeaveMinutes: 0,
      totalAbsentDays: 0,
      totalLeaveHours: 0,
      totalOvertimeHours: 0,
      totalCompensatoryUsedHours: 0,
      totalCompensatoryRemainingHours: 0,
      totalBusinessTripDays: 0,
      totalAnomalyCount: 0,
      _count: 0,
    });

    const overall = createEmptyDept('全体');

    for (const item of params.items) {
      const { employee, params: singleParams } = item;
      const summary = this.generateMonthlySummary(singleParams);
      summaries[employee.id] = summary;

      const leaveTotalHours = summary.leaveDetails.reduce((sum, d) => sum + d.totalHours, 0);

      overall.employeeCount++;
      overall._count++;
      overall.totalWorkDays += summary.totalWorkDays;
      overall.totalActualWorkDays += summary.actualWorkDays;
      overall.totalWorkHours += summary.totalWorkHours;
      overall.totalActualWorkHours += summary.actualWorkHours;
      overall.totalLateCount += summary.lateCount;
      overall.totalLateMinutes += summary.lateTotalMinutes;
      overall.totalEarlyLeaveCount += summary.earlyLeaveCount;
      overall.totalEarlyLeaveMinutes += summary.earlyLeaveTotalMinutes;
      overall.totalAbsentDays += summary.absentDays;
      overall.totalLeaveHours += leaveTotalHours;
      overall.totalOvertimeHours += summary.overtimeHours;
      overall.totalCompensatoryUsedHours += summary.compensatoryLeaveUsedHours;
      overall.totalCompensatoryRemainingHours += summary.compensatoryLeaveRemainingHours;
      overall.totalBusinessTripDays += summary.businessTripDays;
      overall.totalAnomalyCount += summary.anomalyCount;

      const deptName = employee.department || '未分配';
      if (!byDepartment[deptName]) {
        byDepartment[deptName] = createEmptyDept(deptName);
      }
      const dept = byDepartment[deptName];
      dept.employeeCount++;
      dept._count++;
      dept.totalWorkDays += summary.totalWorkDays;
      dept.totalActualWorkDays += summary.actualWorkDays;
      dept.totalWorkHours += summary.totalWorkHours;
      dept.totalActualWorkHours += summary.actualWorkHours;
      dept.totalLateCount += summary.lateCount;
      dept.totalLateMinutes += summary.lateTotalMinutes;
      dept.totalEarlyLeaveCount += summary.earlyLeaveCount;
      dept.totalEarlyLeaveMinutes += summary.earlyLeaveTotalMinutes;
      dept.totalAbsentDays += summary.absentDays;
      dept.totalLeaveHours += leaveTotalHours;
      dept.totalOvertimeHours += summary.overtimeHours;
      dept.totalCompensatoryUsedHours += summary.compensatoryLeaveUsedHours;
      dept.totalCompensatoryRemainingHours += summary.compensatoryLeaveRemainingHours;
      dept.totalBusinessTripDays += summary.businessTripDays;
      dept.totalAnomalyCount += summary.anomalyCount;
    }

    const cleanByDepartment: Record<string, DepartmentMonthlySummary> = {};
    for (const [name, dept] of Object.entries(byDepartment)) {
      const { _count, ...rest } = dept;
      cleanByDepartment[name] = {
        ...rest,
        totalWorkHours: roundHours(rest.totalWorkHours),
        totalActualWorkHours: roundHours(rest.totalActualWorkHours),
        totalLeaveHours: roundHours(rest.totalLeaveHours),
        totalOvertimeHours: roundHours(rest.totalOvertimeHours),
        totalCompensatoryUsedHours: roundHours(rest.totalCompensatoryUsedHours),
        totalCompensatoryRemainingHours: roundHours(rest.totalCompensatoryRemainingHours),
      };
    }

    const { _count: _, ...overallRest } = overall;
    const overallSummary: DepartmentMonthlySummary = {
      ...overallRest,
      totalWorkHours: roundHours(overallRest.totalWorkHours),
      totalActualWorkHours: roundHours(overallRest.totalActualWorkHours),
      totalLeaveHours: roundHours(overallRest.totalLeaveHours),
      totalOvertimeHours: roundHours(overallRest.totalOvertimeHours),
      totalCompensatoryUsedHours: roundHours(overallRest.totalCompensatoryUsedHours),
      totalCompensatoryRemainingHours: roundHours(overallRest.totalCompensatoryRemainingHours),
    };

    return {
      summaries,
      byDepartment: cleanByDepartment,
      overallSummary,
    };
  }
}
