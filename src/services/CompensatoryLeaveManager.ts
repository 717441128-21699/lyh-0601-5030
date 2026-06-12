import { OvertimeRecord, LeaveTypeCode, LeaveBalance } from '../types';
import { LeaveBalanceManager } from './LeaveBalanceManager';
import { roundHours } from '../utils/dateUtils';

export interface CompensatoryConversionResult {
  success: boolean;
  requestedHours: number;
  convertedHours: number;
  beforeConvertedHours: number;
  afterConvertedHours: number;
  remainingOvertimeHours: number;
  compensatoryBalance: number;
  message: string;
  updatedRecord?: OvertimeRecord;
}

export interface CompensatoryUseResult {
  success: boolean;
  usedHours: number;
  remainingHours: number;
  insufficientBalance: boolean;
  message: string;
}

export interface CompensatoryRollbackResult {
  success: boolean;
  rolledBackHours: number;
  remainingHours: number;
  message: string;
}

export class CompensatoryLeaveManager {
  private balanceManager: LeaveBalanceManager;
  private overtimeRecords: Map<string, OvertimeRecord>;
  private readonly COMPENSATORY_CODE: LeaveTypeCode = 'compensatory';

  constructor(
    balanceManager: LeaveBalanceManager,
    overtimeRecords: OvertimeRecord[] = []
  ) {
    this.balanceManager = balanceManager;
    this.overtimeRecords = new Map();
    overtimeRecords.forEach((r) => this.overtimeRecords.set(r.id, { ...r }));
  }

  addOvertimeRecord(record: OvertimeRecord): void {
    this.overtimeRecords.set(record.id, { ...record });
  }

  addOvertimeRecords(records: OvertimeRecord[]): void {
    records.forEach((r) => this.addOvertimeRecord(r));
  }

  getOvertimeRecord(id: string): OvertimeRecord | undefined {
    return this.overtimeRecords.get(id);
  }

  getEmployeeOvertimeRecords(employeeId: string): OvertimeRecord[] {
    return Array.from(this.overtimeRecords.values()).filter(
      (r) => r.employeeId === employeeId
    );
  }

  getUnconvertedOvertimeHours(employeeId: string): number {
    const records = this.getEmployeeOvertimeRecords(employeeId).filter(
      (r) => r.approved
    );
    return roundHours(records.reduce((sum, r) => {
      const converted = r.convertedHours || 0;
      return sum + (r.durationHours - converted);
    }, 0));
  }

  getConvertedOvertimeHours(employeeId: string): number {
    const records = this.getEmployeeOvertimeRecords(employeeId).filter(
      (r) => r.approved
    );
    return roundHours(records.reduce((sum, r) => sum + (r.convertedHours || 0), 0));
  }

  convertOvertimeToCompensatory(
    overtimeRecordId: string,
    hours?: number,
    minUnitHours: number = 0.5
  ): CompensatoryConversionResult {
    const record = this.overtimeRecords.get(overtimeRecordId);

    if (!record) {
      return {
        success: false,
        requestedHours: hours ?? 0,
        convertedHours: 0,
        beforeConvertedHours: 0,
        afterConvertedHours: 0,
        remainingOvertimeHours: 0,
        compensatoryBalance: 0,
        message: '未找到对应的加班记录',
      };
    }

    const beforeConverted = record.convertedHours || 0;
    const remainingOvertime = roundHours(record.durationHours - beforeConverted);
    const employeeId = record.employeeId;

    if (!record.approved) {
      return {
        success: false,
        requestedHours: hours ?? 0,
        convertedHours: 0,
        beforeConvertedHours: beforeConverted,
        afterConvertedHours: beforeConverted,
        remainingOvertimeHours: remainingOvertime,
        compensatoryBalance: this.getBalance(employeeId),
        message: '加班记录尚未审批通过，无法转调休',
      };
    }

    if (remainingOvertime <= 0) {
      return {
        success: false,
        requestedHours: hours ?? 0,
        convertedHours: 0,
        beforeConvertedHours: beforeConverted,
        afterConvertedHours: beforeConverted,
        remainingOvertimeHours: 0,
        compensatoryBalance: this.getBalance(employeeId),
        message: '该加班记录已全部转为调休，无剩余可转时长',
      };
    }

    const requestedRaw = hours ?? remainingOvertime;
    const requestedHours = roundHours(requestedRaw);

    if (requestedHours <= 0) {
      return {
        success: false,
        requestedHours,
        convertedHours: 0,
        beforeConvertedHours: beforeConverted,
        afterConvertedHours: beforeConverted,
        remainingOvertimeHours: remainingOvertime,
        compensatoryBalance: this.getBalance(employeeId),
        message: '转调休时长必须大于0',
      };
    }

    const minUnit = Math.max(0.01, minUnitHours);
    const ratio = requestedHours / minUnit;
    if (Math.abs(ratio - Math.round(ratio)) > 0.001) {
      return {
        success: false,
        requestedHours,
        convertedHours: 0,
        beforeConvertedHours: beforeConverted,
        afterConvertedHours: beforeConverted,
        remainingOvertimeHours: remainingOvertime,
        compensatoryBalance: this.getBalance(employeeId),
        message: `转调休时长必须是最小单位(${minUnit}小时)的整数倍`,
      };
    }

    if (requestedHours > remainingOvertime) {
      return {
        success: false,
        requestedHours,
        convertedHours: 0,
        beforeConvertedHours: beforeConverted,
        afterConvertedHours: beforeConverted,
        remainingOvertimeHours: remainingOvertime,
        compensatoryBalance: this.getBalance(employeeId),
        message: `转调休时长(${requestedHours}小时)超过剩余可转加班时长(${remainingOvertime}小时)`,
      };
    }

    record.convertedHours = roundHours(beforeConverted + requestedHours);
    record.convertedToCompensatory = record.convertedHours >= record.durationHours;
    if (record.convertedToCompensatory && record.compensatoryHoursUsed === undefined) {
      record.compensatoryHoursUsed = 0;
    }

    this.balanceManager.increaseBalance(
      employeeId,
      this.COMPENSATORY_CODE,
      requestedHours
    );

    const newRemaining = roundHours(record.durationHours - record.convertedHours);

    return {
      success: true,
      requestedHours,
      convertedHours: requestedHours,
      beforeConvertedHours: beforeConverted,
      afterConvertedHours: record.convertedHours,
      remainingOvertimeHours: newRemaining,
      compensatoryBalance: this.getBalance(employeeId),
      message: newRemaining > 0
        ? `成功将 ${requestedHours} 小时加班转为调休，该记录还剩 ${newRemaining} 小时可继续转（累计已转 ${record.convertedHours} 小时）`
        : `成功将 ${requestedHours} 小时加班转为调休，该记录已全部转完（累计 ${record.convertedHours} 小时）`,
      updatedRecord: { ...record },
    };
  }

  getBalance(employeeId: string): number {
    return this.balanceManager.getRemainingBalance(employeeId, this.COMPENSATORY_CODE);
  }

  getBalanceDetail(employeeId: string): LeaveBalance | undefined {
    return this.balanceManager.getBalance(employeeId, this.COMPENSATORY_CODE);
  }

  useCompensatory(employeeId: string, hours: number): CompensatoryUseResult {
    const roundedHours = roundHours(hours);

    if (roundedHours <= 0) {
      return {
        success: false,
        usedHours: 0,
        remainingHours: this.getBalance(employeeId),
        insufficientBalance: false,
        message: '使用时长必须大于0',
      };
    }

    const deductionResult = this.balanceManager.deduct(
      employeeId,
      this.COMPENSATORY_CODE,
      roundedHours
    );

    if (!deductionResult.success) {
      return {
        success: false,
        usedHours: 0,
        remainingHours: deductionResult.remainingBalance,
        insufficientBalance: true,
        message: deductionResult.message,
      };
    }

    this.updateUsedHoursInRecords(employeeId, roundedHours);

    return {
      success: true,
      usedHours: roundedHours,
      remainingHours: deductionResult.remainingBalance,
      insufficientBalance: false,
      message: `成功使用 ${roundedHours} 小时调休`,
    };
  }

  private updateUsedHoursInRecords(employeeId: string, hours: number): void {
    let remaining = hours;
    const records = this.getEmployeeOvertimeRecords(employeeId)
      .filter((r) => (r.convertedHours || 0) > 0)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    for (const record of records) {
      if (remaining <= 0) break;

      const converted = record.convertedHours || 0;
      const used = record.compensatoryHoursUsed || 0;
      const available = converted - used;
      if (available > 0) {
        const useFromThis = Math.min(remaining, available);
        record.compensatoryHoursUsed = used + useFromThis;
        remaining -= useFromThis;
      }
    }
  }

  rollbackCompensatory(employeeId: string, hours: number): CompensatoryRollbackResult {
    const roundedHours = roundHours(hours);

    if (roundedHours <= 0) {
      return {
        success: false,
        rolledBackHours: 0,
        remainingHours: this.getBalance(employeeId),
        message: '回滚时长必须大于0',
      };
    }

    const rollbackResult = this.balanceManager.rollback(
      employeeId,
      this.COMPENSATORY_CODE,
      roundedHours
    );

    if (!rollbackResult.success) {
      return {
        success: false,
        rolledBackHours: 0,
        remainingHours: this.getBalance(employeeId),
        message: rollbackResult.message,
      };
    }

    this.rollbackUsedHoursInRecords(employeeId, rollbackResult.rolledBackHours);

    return {
      success: true,
      rolledBackHours: rollbackResult.rolledBackHours,
      remainingHours: rollbackResult.remainingBalance,
      message: rollbackResult.message,
    };
  }

  private rollbackUsedHoursInRecords(employeeId: string, hours: number): void {
    let remaining = hours;
    const records = this.getEmployeeOvertimeRecords(employeeId)
      .filter((r) => (r.compensatoryHoursUsed || 0) > 0)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    for (const record of records) {
      if (remaining <= 0) break;

      const used = record.compensatoryHoursUsed || 0;
      if (used > 0) {
        const rollbackFromThis = Math.min(remaining, used);
        record.compensatoryHoursUsed = used - rollbackFromThis;
        remaining -= rollbackFromThis;
      }
    }
  }

  getTotalConvertedHours(employeeId: string): number {
    return this.getConvertedOvertimeHours(employeeId);
  }

  getTotalUsedHours(employeeId: string): number {
    const balance = this.getBalanceDetail(employeeId);
    return balance ? balance.usedHours : 0;
  }

  hasSufficientBalance(employeeId: string, requiredHours: number): boolean {
    return this.getBalance(employeeId) >= requiredHours;
  }

  clear(): void {
    this.overtimeRecords.clear();
  }
}
