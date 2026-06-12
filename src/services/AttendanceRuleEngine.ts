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
    hours?: number
  ): CompensatoryConversionResult {
    return this.compensatoryLeaveManager.convertOvertimeToCompensatory(
      overtimeRecordId,
      hours
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
}
