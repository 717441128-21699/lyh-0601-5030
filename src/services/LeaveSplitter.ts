import {
  LeaveSegment,
  LeaveCalculationRequest,
  LeaveCalculationResult,
  LeaveType,
  WorkSchedule,
  LeaveUnit,
} from '../types';
import { WorkdayChecker } from './WorkdayChecker';
import { ShiftCalculator } from './ShiftCalculator';
import {
  getDatePart,
  generateDateRange,
  isDateTimeSameDay,
  createDateTime,
  parseDateTime,
  diffHours,
  roundHours,
  formatDate,
} from '../utils/dateUtils';

export class LeaveSplitter {
  private workdayChecker: WorkdayChecker;
  private shiftCalculator: ShiftCalculator;
  private leaveTypes: Map<string, LeaveType>;

  constructor(
    workdayChecker: WorkdayChecker,
    shiftCalculator: ShiftCalculator,
    leaveTypes: LeaveType[] = []
  ) {
    this.workdayChecker = workdayChecker;
    this.shiftCalculator = shiftCalculator;
    this.leaveTypes = new Map();
    leaveTypes.forEach((lt) => this.leaveTypes.set(lt.code, lt));
  }

  setLeaveTypes(leaveTypes: LeaveType[]): void {
    this.leaveTypes.clear();
    leaveTypes.forEach((lt) => this.leaveTypes.set(lt.code, lt));
  }

  addLeaveType(leaveType: LeaveType): void {
    this.leaveTypes.set(leaveType.code, leaveType);
  }

  calculateLeave(request: LeaveCalculationRequest): LeaveCalculationResult {
    const warnings: string[] = [];
    const tips: string[] = [];
    const leaveType = this.leaveTypes.get(request.leaveTypeCode);

    if (!leaveType) {
      return {
        success: false,
        deductedHours: 0,
        splitSegments: [],
        hasConflict: false,
        insufficientBalance: false,
        warnings: ['未找到对应的假期类型配置'],
        tips: [],
      };
    }

    const scheduleMap = new Map<string, WorkSchedule>();
    request.schedules.forEach((s) => scheduleMap.set(s.date, s));

    const dates = this.getLeaveDateRange(request.startTime, request.endTime);

    const splitSegments: LeaveSegment[] = [];
    let totalDeductedHours = 0;

    for (const date of dates) {
      const schedule = scheduleMap.get(date);
      const isWorkDay = schedule
        ? !schedule.isRestDay && !schedule.isHoliday
        : this.workdayChecker.isWorkDay(date, undefined);

      const isHoliday = schedule
        ? !!schedule.isHoliday
        : this.workdayChecker.isHoliday(date);

      const skipThisDay =
        (leaveType.skipWeekends && this.workdayChecker.isWeekend(date) && !this.workdayChecker.isMakeupWorkday(date)) ||
        (leaveType.skipHolidays && isHoliday && !this.workdayChecker.isMakeupWorkday(date));

      if (skipThisDay) {
        if (this.workdayChecker.isWeekend(date) && leaveType.skipWeekends) {
          tips.push(`${date} 为周末，已跳过`);
        }
        if (isHoliday && leaveType.skipHolidays) {
          const holidayInfo = this.workdayChecker.getHolidayInfo(date);
          tips.push(`${date} 为节假日${holidayInfo ? `(${holidayInfo.name})` : ''}，已跳过`);
        }
        continue;
      }

      if (!isWorkDay && !isHoliday && !this.workdayChecker.isMakeupWorkday(date)) {
        if (!leaveType.skipWeekends) {
          tips.push(`${date} 为非工作日，但假期类型未设置跳过周末`);
        }
      }

      const shift = schedule?.shift;
      if (!shift) {
        warnings.push(`${date} 未找到排班信息`);
        continue;
      }

      const segment = this.calculateDaySegment(
        date,
        request,
        shift,
        isWorkDay,
        isHoliday
      );

      if (segment.durationHours > 0) {
        splitSegments.push(segment);
        totalDeductedHours += segment.durationHours;
      }
    }

    if (splitSegments.length === 0) {
      warnings.push('请假时间范围内没有有效的工作日');
    }

    totalDeductedHours = roundHours(totalDeductedHours);

    if (request.unit === 'half_day') {
      const halfDayHours = this.getHalfDayHours(splitSegments);
      if (halfDayHours > 0 && totalDeductedHours > halfDayHours) {
        totalDeductedHours = halfDayHours;
      }
    } else if (request.unit === 'day') {
      const dayHours = this.getFullDayHours(splitSegments);
      if (dayHours > 0) {
        totalDeductedHours = roundHours(dayHours * splitSegments.length);
      }
    }

    const hasConflict = this.checkTimeConflict(request, splitSegments);
    const conflictDetails: string[] = [];

    if (hasConflict && request.existingLeaves) {
      request.existingLeaves
        .filter((l) => l.id !== request.excludeRequestId && l.status !== 'rejected' && l.status !== 'cancelled')
        .forEach((existing) => {
          const overlap = this.calculateLeaveOverlap(
            request.startTime,
            request.endTime,
            existing.startTime,
            existing.endTime
          );
          if (overlap > 0) {
            conflictDetails.push(`与请假单 ${existing.id} 存在时间重叠`);
          }
        });
    }

    return {
      success: splitSegments.length > 0 && !warnings.some((w) => w.includes('未找到')),
      deductedHours: totalDeductedHours,
      splitSegments,
      hasConflict,
      conflictDetails: conflictDetails.length > 0 ? conflictDetails : undefined,
      insufficientBalance: false,
      warnings,
      tips,
    };
  }

  private getLeaveDateRange(startTime: string, endTime: string): string[] {
    const startDate = getDatePart(startTime);
    const endDate = getDatePart(endTime);
    return generateDateRange(startDate, endDate);
  }

  private calculateDaySegment(
    date: string,
    request: LeaveCalculationRequest,
    shift: NonNullable<WorkSchedule['shift']>,
    isWorkDay: boolean,
    isHoliday: boolean
  ): LeaveSegment {
    const startDt = parseDateTime(request.startTime);
    const endDt = parseDateTime(request.endTime);
    const shiftStart = parseDateTime(createDateTime(date, shift.startTime));

    let shiftEnd = parseDateTime(createDateTime(date, shift.endTime));
    if (shiftEnd <= shiftStart) {
      const nextDay = new Date(date);
      nextDay.setDate(nextDay.getDate() + 1);
      shiftEnd = parseDateTime(createDateTime(formatDate(nextDay), shift.endTime));
    }

    let segmentStart = startDt > shiftStart ? startDt : shiftStart;
    let segmentEnd = endDt < shiftEnd ? endDt : shiftEnd;

    const startIsSameDay = isDateTimeSameDay(formatDate(segmentStart), date);
    const endIsSameDay = isDateTimeSameDay(formatDate(segmentEnd), date);

    const dateStart = parseDateTime(createDateTime(date, '00:00'));
    const dateEnd = parseDateTime(createDateTime(date, '23:59:59'));

    if (!startIsSameDay) {
      segmentStart = shiftStart;
    }
    if (!endIsSameDay) {
      segmentEnd = shiftEnd;
    }

    if (segmentStart < dateStart) {
      segmentStart = shiftStart > dateStart ? shiftStart : dateStart;
    }
    if (segmentEnd > new Date(dateEnd.getTime() + 86400000)) {
      const nextDateEnd = new Date(dateEnd.getTime() + 86400000);
      segmentEnd = shiftEnd < nextDateEnd ? shiftEnd : nextDateEnd;
    }

    const leaveStart = this.formatDateTime(segmentStart);
    const leaveEnd = this.formatDateTime(segmentEnd);

    const deduction = this.shiftCalculator.calculateLeaveDeductionHours(
      shift,
      date,
      leaveStart,
      leaveEnd
    );

    let duration = deduction.hours;

    if (request.unit === 'hour') {
      const hoursDiff = diffHours(leaveStart, leaveEnd);
      duration = Math.min(duration, hoursDiff);
    }

    return {
      date,
      startTime: leaveStart,
      endTime: leaveEnd,
      durationHours: roundHours(duration),
      isWorkDay,
      isHoliday,
      shiftId: shift.id,
    };
  }

  private formatDateTime(dt: Date): string {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    const h = String(dt.getHours()).padStart(2, '0');
    const min = String(dt.getMinutes()).padStart(2, '0');
    const s = String(dt.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${d} ${h}:${min}:${s}`;
  }

  private getHalfDayHours(segments: LeaveSegment[]): number {
    if (segments.length === 0) return 0;
    return segments[0].durationHours / 2;
  }

  private getFullDayHours(segments: LeaveSegment[]): number {
    if (segments.length === 0) return 0;
    return segments[0].durationHours;
  }

  private checkTimeConflict(
    request: LeaveCalculationRequest,
    segments: LeaveSegment[]
  ): boolean {
    if (!request.existingLeaves || request.existingLeaves.length === 0) {
      return false;
    }

    for (const existing of request.existingLeaves) {
      if (existing.id === request.excludeRequestId) continue;
      if (existing.status === 'rejected' || existing.status === 'cancelled') continue;

      const overlap = this.calculateLeaveOverlap(
        request.startTime,
        request.endTime,
        existing.startTime,
        existing.endTime
      );

      if (overlap > 0) {
        return true;
      }
    }

    return false;
  }

  private calculateLeaveOverlap(
    start1: string,
    end1: string,
    start2: string,
    end2: string
  ): number {
    const s1 = parseDateTime(start1).getTime();
    const e1 = parseDateTime(end1).getTime();
    const s2 = parseDateTime(start2).getTime();
    const e2 = parseDateTime(end2).getTime();

    const overlapStart = Math.max(s1, s2);
    const overlapEnd = Math.min(e1, e2);

    if (overlapStart >= overlapEnd) return 0;
    return (overlapEnd - overlapStart) / (1000 * 60 * 60);
  }

  validateLeaveUnit(unit: LeaveUnit, leaveTypeCode: string): { valid: boolean; message?: string } {
    const leaveType = this.leaveTypes.get(leaveTypeCode);
    if (!leaveType) {
      return { valid: false, message: '未找到假期类型' };
    }

    if (leaveType.unit === 'day' && unit === 'hour') {
      return { valid: false, message: '该假期类型不支持按小时请假' };
    }

    return { valid: true };
  }
}
